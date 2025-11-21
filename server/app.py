# /opt/cfd-orchestrator/server/app.py
from typing import Optional, Dict, Tuple, Any, List
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from jsonschema import Draft202012Validator
from pathlib import Path
from dotenv import load_dotenv
import httpx
import json
import os
import logging
import textwrap
import re
from datetime import datetime
from uuid import uuid4

# ---------- 日志 ----------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("cfd-orchestrator")

# ---------- 常量与路径 ----------
ROOT = Path("/opt/cfd-orchestrator")
SCHEMA_DIR = ROOT / "schemas" / "intent"
STORAGE_DIR = ROOT / "storage"

# 读取 .env（固定从 server/ 目录加载）
ENV_FILE = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=ENV_FILE)

# CORS
CORS_ALLOW_ORIGINS = [
    o.strip()
    for o in os.getenv(
        "CORS_ALLOW_ORIGINS",
        "http://localhost:8000,http://127.0.0.1:8000,http://14.103.118.93:8000",
    ).split(",")
    if o.strip()
]

app = FastAPI(title="CFD Orchestrator Mini API", version="0.5")
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOW_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------- LLM 环境变量 ----------
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").rstrip("/")
LLM_COMPLETIONS_PATH = os.getenv("LLM_COMPLETIONS_PATH", "/chat/completions")
LLM_MODEL = os.getenv("LLM_MODEL", "")
LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_TIMEOUT = float(os.getenv("LLM_TIMEOUT", "60"))
LLM_FORCE_JSON = os.getenv("LLM_FORCE_JSON", "1")

# ---------- Profile 注册表（两套 Intent 并存） ----------
PROFILE_REGISTRY: Dict[str, dict] = {
    # Fluent + 外部网格（.msh）
    "coolingplate-mesh-v1": {
        "label": "Fluent + 外部网格 (.msh)",
        "family": "fluent",
        "profile": "CoolingPlate-Intent@mesh_v1.0",
        "schema": SCHEMA_DIR / "coolingplate_intent_mesh_v1.schema.json",
        "template": SCHEMA_DIR / "coolingplate_intent_mesh_v1.template.json",
    },
    # OpenFOAM + 自动 blockMesh（无外部网格时）
    "coolingplate-openfoam-bmesh-v1": {
        "label": "OpenFOAM + 自动 blockMesh",
        "family": "openfoam",
        "profile": "CoolingPlate-OF-Intent@blockMesh_v1.0",
        "schema": SCHEMA_DIR / "coolingplate_intent_openfoam_bmesh_v1.schema.json",
        "template": SCHEMA_DIR / "coolingplate_intent_openfoam_bmesh_v1.template.json",
    },
}
DEFAULT_PROFILE_SLUG = "coolingplate-openfoam-bmesh-v1"
# 反向映射（通过 intent.profile 找到 schema/template）
PROFILE_BY_NAME = {meta["profile"]: {**meta, "slug": slug} for slug, meta in PROFILE_REGISTRY.items()}

COLLECT_REQUIRED_NOTE = (
    "关键字段需覆盖：\n"
    "1. 几何尺寸：meshing.blockMesh.geometry.dimension_mode，length_m，width_m，以及 height_m（3D）或 thickness_2d_m（2D）。\n"
    "2. 入口条件：operating_conditions.inlets[0] 的 quantity、value.si/unit 与 T_in.si。\n"
    "3. 出口压力：operating_conditions.outlets[0].p.si/unit。\n"
    "4. 热载荷：thermal_loads[0].value.si/unit。\n"
    "5. 流体材料名称：materials.fluid.name（若未给出可建议水）。"
)

# ---------- Pydantic 请求体 ----------
class SummaryRequest(BaseModel):
    intent: dict  # 必须包含 intent.profile

class FillRequest(BaseModel):
    user_request: str
    profile_slug: str                 # 前端必须传：coolingplate-openfoam-bmesh-v1 | coolingplate-mesh-v1
    use_template: bool = True
    model: Optional[str] = None       # 前端选择的 LLM 别名（deepseek-v1/gpt-4o-mini/...）
    client_intent: Optional[dict] = None  # 前端可回传默认值/补充信息

class ApplyIntentRequest(BaseModel):
    intent: dict

class FillFastRequest(BaseModel):
    user_request: str
    profile_slug: str = DEFAULT_PROFILE_SLUG
    dimension_mode: Optional[str] = None  # "3D" | "2D_extruded"
    model: Optional[str] = None
    job_meta: Optional[dict] = None


class ValidateIntentRequest(BaseModel):
    intent: dict
    profile_slug: Optional[str] = None


class SaveIntentRequest(BaseModel):
    intent: dict
    profile_slug: Optional[str] = None
    job_meta: Optional[dict] = None

# ---------- 工具函数 ----------
def _strip_json_comments(raw: str) -> str:
    """Remove // and /* */ style comments from JSON-like text."""

    result: List[str] = []
    i = 0
    length = len(raw)
    in_string = False
    escape = False
    string_delim = ""

    while i < length:
        ch = raw[i]

        if in_string:
            result.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == string_delim:
                in_string = False
            i += 1
            continue

        if ch in ('"', "'"):
            in_string = True
            string_delim = ch
            result.append(ch)
            i += 1
            continue

        if ch == "/" and i + 1 < length:
            nxt = raw[i + 1]
            if nxt == "/":
                i += 2
                while i < length and raw[i] not in "\r\n":
                    i += 1
                continue
            if nxt == "*":
                i += 2
                while i + 1 < length and not (raw[i] == "*" and raw[i + 1] == "/"):
                    i += 1
                i += 2
                continue

        result.append(ch)
        i += 1

    return "".join(result)

def load_json(p: Path) -> dict:
    if not p.exists():
        raise FileNotFoundError(str(p))
    raw = p.read_text(encoding="utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        stripped = _strip_json_comments(raw)
        if stripped != raw:
            try:
                log.warning("Parsing JSON with comment stripping: %s", p)
                return json.loads(stripped)
            except json.JSONDecodeError as err:
                log.error("Failed to parse JSON after stripping comments: %s", p, exc_info=True)
                raise ValueError(f"JSON decode error in {p}: {err}") from err
        log.error("Failed to parse JSON file: %s", p, exc_info=True)
        raise

def schema_validate(instance: dict, schema: dict):
    validator = Draft202012Validator(schema)
    return sorted(validator.iter_errors(instance), key=lambda e: e.path)
    
def format_schema_errors(errors) -> Dict[str, object]:
    issues = []
    for err in errors:
        path = "$"
        for part in err.path:
            if isinstance(part, int):
                path += f"[{part}]"
            else:
                path += f".{part}"
        issues.append({"path": path, "message": err.message})
    return {"valid": len(issues) == 0, "issues": issues}

def ensure_storage_dir():
    if not STORAGE_DIR.exists():
        STORAGE_DIR.mkdir(parents=True, exist_ok=True)

def save_intent_to_storage(intent: dict, profile_slug: str) -> Tuple[str, Path]:
    ensure_storage_dir()
    timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%S")
    safe_slug = profile_slug.replace("/", "-")
    filename = f"{safe_slug}_{timestamp}.json"
    target = STORAGE_DIR / filename
    with target.open("w", encoding="utf-8") as f:
        json.dump(intent, f, ensure_ascii=False, indent=2)
    return filename, target

def normalize_job_id(raw: Optional[str]) -> str:
    value = str(raw or "").strip()
    if value:
        sanitized = re.sub(r"[^0-9A-Za-z_-]", "-", value)
        sanitized = sanitized.strip("-")
        if sanitized:
            return sanitized[:120]
    random_tail = uuid4().hex[:6]
    return f"job-{datetime.utcnow().strftime('%Y%m%dT%H%M%S')}-{random_tail}"


def save_intent_with_job_directory(intent: dict) -> Tuple[dict, str, str, str]:
    ensure_storage_dir()
    final_intent = deep_copy_json(intent)
    job_meta = final_intent.setdefault("job_meta", {}) if isinstance(final_intent.get("job_meta"), dict) else {}
    if not isinstance(job_meta, dict):
        job_meta = {}
    final_intent["job_meta"] = job_meta
    job_id = normalize_job_id(job_meta.get("job_id"))
    job_meta["job_id"] = job_id
    job_dir = STORAGE_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    target = job_dir / "intent.json"
    with target.open("w", encoding="utf-8") as f:
        json.dump(final_intent, f, ensure_ascii=False, indent=2)
    relative_path = f"{job_id}/intent.json"
    storage_path = f"storage/{relative_path}"
    return final_intent, job_id, relative_path, storage_path

def deep_copy_json(data: dict) -> dict:
    return json.loads(json.dumps(data, ensure_ascii=False))

def merge_with_template(template_obj: dict, overrides: Optional[dict]) -> dict:
    base = deep_copy_json(template_obj)
    if not isinstance(overrides, dict):
        return base

    def _merge(dst: dict, src: dict):
        for key, value in src.items():
            if isinstance(value, dict) and isinstance(dst.get(key), dict):
                _merge(dst[key], value)
            else:
                dst[key] = value

    _merge(base, overrides)
    return base

VALID_DIMENSION_MODES = {"3D", "2D_extruded"}


def normalize_dimension_mode(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    value = str(raw).strip()
    return value if value in VALID_DIMENSION_MODES else None


def coerce_string_list(value: Any) -> List[str]:
    result: List[str] = []
    if value is None:
        return result
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                text = item.strip()
                if text:
                    result.append(text)
            elif isinstance(item, dict):
                for key in ("text", "message", "detail"):
                    candidate = item.get(key)
                    if isinstance(candidate, str):
                        text = candidate.strip()
                        if text:
                            result.append(text)
                        break
            else:
                text = str(item).strip()
                if text:
                    result.append(text)
        return result
    if isinstance(value, str):
        for piece in value.splitlines():
            text = piece.strip()
            if text:
                result.append(text)
        return result
    text = str(value).strip()
    if text:
        result.append(text)
    return result


def apply_dimension_mode_to_template(template_obj: dict, dimension_mode: Optional[str]) -> dict:
    base = deep_copy_json(template_obj)
    mode = normalize_dimension_mode(dimension_mode)
    if not mode:
        return base
    try:
        meshing = base.setdefault("meshing", {})
        block = meshing.setdefault("blockMesh", {})
        geometry = block.setdefault("geometry", {})
        geometry["dimension_mode"] = mode
        cells = block.setdefault("cells", {})
        if mode == "2D_extruded":
            thickness = geometry.get("thickness_2d_m")
            if not isinstance(thickness, (int, float)):
                fallback = geometry.get("height_m")
                if not isinstance(fallback, (int, float)):
                    fallback = 0.002
                geometry["thickness_2d_m"] = fallback
            nz = cells.get("nz")
            if isinstance(nz, int):
                cells["nz"] = max(2, min(nz, 10))
            else:
                cells["nz"] = 4
        else:
            height = geometry.get("height_m")
            if not isinstance(height, (int, float)):
                fallback = geometry.get("thickness_2d_m")
                if isinstance(fallback, (int, float)):
                    geometry["height_m"] = fallback
    except Exception as exc:
        log.debug("apply_dimension_mode_to_template failed: %s", exc, exc_info=True)
    return base


def enforce_dimension_mode(intent_obj: dict, dimension_mode: Optional[str], template_obj: dict):
    mode = normalize_dimension_mode(dimension_mode)
    if not mode:
        return
    try:
        meshing = intent_obj.setdefault("meshing", {})
        block = meshing.setdefault("blockMesh", {})
        geometry = block.setdefault("geometry", {})
        geometry["dimension_mode"] = mode
        template_geo = (
            (template_obj.get("meshing") or {})
            .get("blockMesh", {})
            .get("geometry", {})
        )
        template_cells = (
            (template_obj.get("meshing") or {})
            .get("blockMesh", {})
            .get("cells", {})
        )
        cells = block.setdefault("cells", {})
        if mode == "2D_extruded":
            thickness = geometry.get("thickness_2d_m")
            if not isinstance(thickness, (int, float)):
                fallback = template_geo.get("thickness_2d_m")
                if not isinstance(fallback, (int, float)):
                    fallback = geometry.get("height_m")
                if not isinstance(fallback, (int, float)):
                    fallback = 0.002
                geometry["thickness_2d_m"] = fallback
            nz = cells.get("nz")
            if isinstance(nz, int):
                cells["nz"] = max(1, min(nz, 10))
            else:
                fallback_nz = template_cells.get("nz")
                if isinstance(fallback_nz, int):
                    cells["nz"] = fallback_nz
        else:
            height = geometry.get("height_m")
            if not isinstance(height, (int, float)):
                fallback = template_geo.get("height_m")
                if not isinstance(fallback, (int, float)):
                    fallback = geometry.get("thickness_2d_m")
                if not isinstance(fallback, (int, float)):
                    fallback = 0.002
                geometry["height_m"] = fallback
    except Exception as exc:
        log.debug("enforce_dimension_mode failed: %s", exc, exc_info=True)

def normalize_missing_parameters(items: Any) -> List[Dict[str, Any]]:
    normalized: List[Dict[str, Any]] = []
    if not isinstance(items, list):
        return normalized
    for item in items:
        if not isinstance(item, dict):
            continue
        label = str(item.get("label") or "").strip()
        if not label:
            group = str(item.get("group") or "").strip()
            label = group if group else "参数"
        detail = str(item.get("detail") or "").strip()
        path = str(item.get("path") or "").strip()
        suggested_raw = item.get("suggested")
        suggested: Dict[str, Any] = {}
        if isinstance(suggested_raw, dict):
            text = str(suggested_raw.get("text") or "").strip()
            if text:
                suggested["text"] = text
            for num_key in ("value", "si"):
                val = suggested_raw.get(num_key)
                if isinstance(val, (int, float)):
                    suggested[num_key] = val
            unit = str(suggested_raw.get("unit") or "").strip()
            if unit:
                suggested["unit"] = unit
        elif isinstance(suggested_raw, str):
            text = suggested_raw.strip()
            if text:
                suggested["text"] = text
        norm = {
            "label": label,
            "detail": detail,
            "path": path,
        }
        if suggested:
            norm["suggested"] = suggested
        normalized.append(norm)
    return normalized

def build_collection_summary(missing: List[Dict[str, Any]], summary_hint: Optional[str] = None) -> str:
    lines = ["【参数收集提示】"]
    hint = (summary_hint or "").strip()
    if hint:
        lines.append(f"· {hint}")
    if missing:
        lines.append(f"· 尚缺 {len(missing)} 项关键参数，请继续补充或采纳建议：")
        for item in missing[:4]:
            label = item.get("label") or "参数"
            detail = item.get("detail") or ""
            suggested = item.get("suggested") or {}
            suggestion_text = ""
            if isinstance(suggested, dict):
                suggestion_text = str(suggested.get("text") or "").strip()
            bullet = f"  - {label}"
            if detail:
                bullet += f"：{detail}"
            if suggestion_text:
                bullet += f"（建议：{suggestion_text}）"
            lines.append(bullet)
    else:
        lines.append("· 核心参数已齐备，可进入校验流程。")
    return "\n".join(lines)

def fmt_val(val_obj: dict, fallback_unit: str = "") -> str:
    if not isinstance(val_obj, dict):
        return ""
    si = val_obj.get("si")
    unit = val_obj.get("unit") or fallback_unit
    orig = val_obj.get("original")
    if si is None:
        return ""
    return f"{si} {unit}（原始 {orig}）" if orig else f"{si} {unit}"

def summarize_intent(intent: dict) -> str:
    """同时兼容两种 profile 的摘要"""
    prof = intent.get("profile", "")
    oc = intent.get("operating_conditions", {}) or {}
    mats = intent.get("materials", {}) or {}
    tls = intent.get("thermal_loads", []) or []
    acc = intent.get("accuracy_pref", {}) or {}
    deliv = intent.get("deliverables", {}) or {}

    # 网格/生成信息
    mesh_txt = ""
    if prof.startswith("CoolingPlate-OF-Intent"):
        meshing = intent.get("meshing", {}) or {}
        mode = meshing.get("mode", "")
        if mode == "blockMesh":
            bm = meshing.get("blockMesh", {}) or {}
            geo = bm.get("geometry", {}) or {}
            fmt_num = lambda v: f"{v}" if v is not None else "未设定"
            dim_mode = geo.get("dimension_mode", "3D")
            L, W = geo.get("length_m"), geo.get("width_m")
            if dim_mode == "2D":
                thickness = geo.get("thickness_2d_m")
                mesh_txt = (
                    "OpenFOAM 自动网格：blockMesh（2D 通道 L="
                    f"{fmt_num(L)} m, W={fmt_num(W)} m, 厚度={fmt_num(thickness)} m）"
                )
            else:
                H = geo.get("height_m")
                mesh_txt = (
                    "OpenFOAM 自动网格：blockMesh（3D 矩形通道 L="
                    f"{fmt_num(L)} m, W={fmt_num(W)} m, H={fmt_num(H)} m）"
                )
        else:
            mesh_txt = f"OpenFOAM 网格模式：{mode or '未指定'}"
    elif prof.startswith("CoolingPlate-Intent@mesh"):
        mesh = intent.get("mesh", {}) or {}
        units_hint = mesh.get("units_hint", "unknown")
        mesh_txt = f"外部网格：Fluent .msh（单位提示：{units_hint}）"

    # 物理/数值（通用）
    time_mode = oc.get("time_mode", "steady")
    flow_regime = oc.get("flow_regime", "incompressible")
    turbulence = oc.get("turbulence", "RANS")
    turb_hint = oc.get("turb_model_hint", "kOmegaSST")
    inlet = (oc.get("inlets") or [{}])[0]
    qtype = inlet.get("quantity", "")
    qval = fmt_val(inlet.get("value", {}))
    Tin = inlet.get("T_in", {})
    Tin_s = f'{Tin.get("si","")} {Tin.get("unit","")}' if Tin else ""
    outlet = (oc.get("outlets") or [{}])[0]
    p_out = fmt_val(outlet.get("p", {}), "Pa")

    heat_txt = ""
    if tls:
        t0 = tls[0]
        heat_txt = f'{t0.get("type","")}: {fmt_val(t0.get("value", {}))}（区域：{t0.get("region_semantic","")}）'

    fluid_name = (mats.get("fluid") or {}).get("name", "water")
    res = acc.get("residual_targets", {}) or {}
    res_txt = f'U {res.get("U","")}, p {res.get("p","")}, T {res.get("T","")}'
    max_iter = acc.get("max_iter", 1000)

    # OpenFOAM 数值细节（可选）
    of_txt = ""
    if prof.startswith("CoolingPlate-OF-Intent"):
        of = intent.get("openfoam", {}) or {}
        solver = of.get("solver", "")
        of_txt = f"· OpenFOAM：求解器 {solver}，松弛建议：{(of.get('numerics') or {}).get('under_relaxation', {})}。"

    reports = ", ".join(deliv.get("reports", []))
    plots = ", ".join(deliv.get("plots", []))
    exports = ", ".join(deliv.get("exports", []))

    zh = []
    zh.append("【液冷板流体传热—意图摘要】")
    if mesh_txt: zh.append(f"· {mesh_txt}。")
    zh.append(
        f"· 工况：{('稳态' if time_mode=='steady' else '瞬态')}，"
        f"{('不可压' if flow_regime=='incompressible' else '低马赫')}；"
        f"{('层流' if turbulence=='laminar' else 'RANS')}（模型建议：{turb_hint}）。"
    )
    zh.append(f"· 入口：以 {qtype} 指定，数值 {qval}，入口温度 {Tin_s}。")
    zh.append(f"· 出口：压力出口 {p_out}。")
    if heat_txt: zh.append(f"· 热载荷：{heat_txt}。")
    zh.append(f"· 流体材料：{fluid_name}。")
    zh.append(f"· 收敛目标：{res_txt}；最大迭代步：{max_iter}。")
    if of_txt: zh.append(of_txt)
    if reports: zh.append(f"· 交付报告：{reports}。")
    if plots: zh.append(f"· 曲线/监控：{plots}。")
    if exports: zh.append(f"· 导出场：{exports}。")
    zh.append("（说明：此为意图层设置；网格/字典/脚本的生成与执行在下一阶段完成。）")
    return "\n".join(zh)

# ---------- LLM 调用 ----------
def system_prompt_for_fast_fill(profile_slug: str) -> str:
    if profile_slug == "coolingplate-openfoam-bmesh-v1":
        return (
            "你是“CFD 意图标准化助手（Intent Normalizer）”。"
            "任务：基于液冷板场景，将用户描述映射为 CoolingPlate-OF-Intent@blockMesh_v1.0 的 JSON。"
            "仅执行字段语义映射与保守默认补齐，不进行任何流动、传热或数值稳定性推断，"
            "禁止计算 Reynolds 数、CFL 数、努塞尔数等指标。"
            "输出格式固定为 {\"intent\": {...}, \"defaults_used\": [...], \"open_questions\": [...]}。"
            "intent 字段需覆盖模板结构并保持 SI 单位，defaults_used 用中文列出默认假设，"
            "open_questions 仅列出需用户确认的要点（若无则返回空数组）。"
            "请严格输出合法 JSON，不要添加额外说明。"
        )
    return (
        "你是“CFD 意图标准化助手（Intent Normalizer）”。"
        "任务：根据给定模板快速生成对应 profile 的 Intent JSON。"
        "仅允许做字段映射和默认值补齐，不得进行任何物理推断或复杂推理。"
        "输出格式固定为 {\"intent\": {...}, \"defaults_used\": [...], \"open_questions\": [...]}，"
        "并严格保持 JSON 结构。"
    )


def build_fill_fast_user_prompt(user_request: str, template_obj: dict, dimension_mode: Optional[str]) -> str:
    request_text = (user_request or "").strip() or "（用户未提供额外描述）"
    mode = normalize_dimension_mode(dimension_mode)
    if mode == "2D_extruded":
        dimension_text = (
            "当前选择：2D 挤出，请设置 meshing.blockMesh.geometry.dimension_mode=\"2D_extruded\"，"
            "并提供 thickness_2d_m（单位 m）。"
        )
    elif mode == "3D":
        dimension_text = (
            "当前选择：3D 通道，请设置 meshing.blockMesh.geometry.dimension_mode=\"3D\"，"
            "并提供 height_m（单位 m）。"
        )
    else:
        dimension_text = "若无特别指定，请保持模板中的几何维度设定。"

    template_text = json.dumps(template_obj, ensure_ascii=False, indent=2)
    instructions = (
        "- intent.profile 必须保持模板中的值；\n"
        "- 数值统一使用 SI 单位；\n"
        "- 缺失信息使用保守默认，并在 defaults_used 中说明；\n"
        "- open_questions 仅在确实需要用户确认时填写，否则返回空数组。"
    )

    return textwrap.dedent(
        f"""
        【用户描述】
        {request_text}

        【几何维度】
        {dimension_text}

        【模板 JSON】
        {template_text}

        【填写说明】
        {instructions}
        仅输出满足结构要求的 JSON。
        """
    ).strip()


async def call_llm_fill_fast(
    user_request: str,
    template_obj: dict,
    profile_slug: str,
    dimension_mode: Optional[str],
    override: Optional[dict] = None,
) -> dict:
    messages = [
        {"role": "system", "content": system_prompt_for_fast_fill(profile_slug)},
        {"role": "user", "content": build_fill_fast_user_prompt(user_request, template_obj, dimension_mode)},
    ]
    return await call_llm_json_response(messages, override=override, force_json=True)

def system_prompt_for_profile(profile_slug: str, canonical: str) -> str:
    """根据选择的 profile 生成对应的人设提示"""
    if profile_slug == "coolingplate-openfoam-bmesh-v1":
        return (
            "你是“CFD 任务意图规范器（Intent Normalizer）”。"
            "场景：液冷板流体传热；目标：输出严格 JSON：CoolingPlate-OF-Intent@blockMesh_v1.0。"
            "仅使用提供的 JSON 模板字段，补齐缺省；单位统一为 SI；"
            "meshing.mode=blockMesh；不要写具体 patch 名，只按 patch_semantics（minX/maxX 等）与 patch_names。"
            "仅输出一个合法 JSON 对象，不要输出多余文字。"
        )
    # 默认：Fluent .msh 意图
    return (
        "你是“CFD 任务意图规范器（Intent Normalizer）”。"
        "场景：液冷板流体传热；目标：输出严格 JSON：CoolingPlate-Intent@mesh_v1.0。"
        "仅使用提供的 JSON 模板字段，补齐缺省；单位统一为 SI；"
        "不要写具体网格 patch 名，只用 semantic（primary_inlet/primary_outlet/heater_zone）。"
        "仅输出一个合法 JSON 对象，不要输出多余文字。"
    )

def build_user_prompt(user_request: str, template_obj: dict) -> str:
    return (
        "【用户描述】\n" + user_request.strip() + "\n\n"
        "【请严格按以下 JSON 骨架填充并仅输出 JSON】\n" +
        json.dumps(template_obj, ensure_ascii=False, indent=2)
    )

def get_override_for_frontend_model(model_alias: Optional[str]) -> Optional[dict]:
    if not model_alias:
        return None
    presets = {
        "deepseek-v1": {
            "base_url": os.getenv("DEEPSEEK_BASE_URL") or LLM_BASE_URL,
            "path": os.getenv("DEEPSEEK_COMPLETIONS_PATH") or LLM_COMPLETIONS_PATH,
            "model": os.getenv("DEEPSEEK_CHAT_MODEL") or LLM_MODEL,
            "api_key": os.getenv("DEEPSEEK_API_KEY") or LLM_API_KEY,
            "force_json": "1",
            "supports_response_format": True,
        },
        "deepseek-r1": {
            "base_url": os.getenv("DEEPSEEK_BASE_URL") or LLM_BASE_URL,
            "path": os.getenv("DEEPSEEK_COMPLETIONS_PATH") or LLM_COMPLETIONS_PATH,
            "model": os.getenv("DEEPSEEK_REASONER_MODEL") or LLM_MODEL,
            "api_key": os.getenv("DEEPSEEK_API_KEY") or LLM_API_KEY,
            "force_json": "0",  # R1 推荐不要强制JSON
            "supports_response_format": True,
        },
        "deepseek-reasoner": {
            "base_url": os.getenv("DEEPSEEK_BASE_URL") or LLM_BASE_URL,
            "path": os.getenv("DEEPSEEK_COMPLETIONS_PATH") or LLM_COMPLETIONS_PATH,
            "model": os.getenv("DEEPSEEK_REASONER_MODEL") or LLM_MODEL,
            "api_key": os.getenv("DEEPSEEK_API_KEY") or LLM_API_KEY,
            "force_json": "1",
            "supports_response_format": True,
        },
        "gpt-4o-mini": {
            "base_url": os.getenv("OPENAI_BASE_URL") or LLM_BASE_URL,
            "path": os.getenv("OPENAI_COMPLETIONS_PATH") or LLM_COMPLETIONS_PATH,
            "model": os.getenv("OPENAI_GPT4O_MINI_MODEL") or LLM_MODEL,
            "api_key": os.getenv("OPENAI_API_KEY") or LLM_API_KEY,
            "force_json": "1",
            "supports_response_format": True,
        },
        "ally-x1": {
            "base_url": os.getenv("ALLY_BASE_URL") or LLM_BASE_URL,
            "path": os.getenv("ALLY_COMPLETIONS_PATH") or LLM_COMPLETIONS_PATH,
            "model": os.getenv("ALLY_MODEL") or LLM_MODEL,
            "api_key": os.getenv("ALLY_API_KEY") or LLM_API_KEY,
            "force_json": "1",
            "supports_response_format": True,
        },
    }
    return presets.get(model_alias)
    
async def call_llm_json_response(
    messages: list,
    override: Optional[dict] = None,
    force_json: Optional[bool] = None,
) -> dict:
    base_url = (override.get("base_url") if override else LLM_BASE_URL).rstrip("/")
    path = (override.get("path") if override else LLM_COMPLETIONS_PATH)
    model = (override.get("model") if override else LLM_MODEL)
    api_key = (override.get("api_key") if override else LLM_API_KEY)
    supports_response_format = (override.get("supports_response_format") if override else True)
    if not base_url or not model or not api_key:
        raise RuntimeError("LLM 基本配置缺失（base_url/model/api_key）")
    
    override_force_json = (override.get("force_json") if override else LLM_FORCE_JSON)
    if force_json is None:
        force_json_flag = "1" if str(override_force_json) == "1" else "0"
    else:
        force_json_flag = "1" if force_json else "0"

    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
    }
    if supports_response_format and force_json_flag == "1":
        payload["response_format"] = {"type": "json_object"}

    url = f"{base_url}{path}"
    log.info("LLM request -> %s model=%s force_json=%s", url, model, force_json_flag)

    async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
        try:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
        except httpx.HTTPStatusError as he:
            snippet = he.response.text[:600]
            raise RuntimeError(f"{he.response.status_code} {he.response.reason_phrase} @ {url} :: {snippet}")
        except httpx.TimeoutException:
            raise RuntimeError(f"上游超时 @ {url}")
        except httpx.RequestError as re:
            raise RuntimeError(f"请求失败 @ {url} :: {re}")

        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            start = content.find("{"); end = content.rfind("}")
            if start >= 0 and end > start:
                return json.loads(content[start:end+1])
            raise RuntimeError(f"模型返回非 JSON：{content[:200]}...")

async def call_llm_fill_intent(
    user_request: str,
    template_obj: dict,
    system_prompt: str,
    override: Optional[dict] = None,
) -> dict:
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": build_user_prompt(user_request, template_obj)},
    ]
    return await call_llm_json_response(messages, override=override, force_json=True)

async def call_llm_collect_parameters(
    user_request: str,
    template_obj: dict,
    override: Optional[dict] = None,
) -> dict:
    system_prompt = textwrap.dedent(
        """
        你是液冷板CFD参数采集助手，负责汇总仿真所需的关键输入。
        请阅读用户描述，结合给定的 JSON 模板，识别哪些字段已有明确数值，哪些仍缺失。
        需要给出缺失字段的说明和建议默认值，并提供完整 JSON。
        所有输出均需使用 SI 单位，profile 必须保持不变。
        输出严格 JSON，对象结构必须为：
        {
          "intent": <根据模板填入已知值的 JSON> ,
          "missing_parameters": [<缺失字段说明列表>],
          "default_intent": <在模板基础上补齐建议默认值后的 JSON>,
          "defaults_overview": {"geometry_text": "", "heat_text": "", "notes": "..."},
          "summary": "简要中文总结"
        }
        missing_parameters 中每项包含 label/detail/path/suggested(text, value, unit)。
        当用户信息充分时，missing_parameters 为空数组，default_intent 与 intent 可一致。
        请勿输出任何额外说明文字。
        """
    ).strip()

    user_prompt = textwrap.dedent(
        f"""
        【用户描述】
        {user_request.strip()}

        【模板 JSON】
        {json.dumps(template_obj, ensure_ascii=False, indent=2)}

        【校验要点】
        {COLLECT_REQUIRED_NOTE}
        请输出满足上述结构的 JSON 对象，未确认的字段可保留模板值。
        """
    ).strip()

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    return await call_llm_json_response(messages, override=override, force_json=True)

async def call_reasoner_review(intent: dict, meta: dict, schema: dict) -> dict:
    override = get_override_for_frontend_model("deepseek-reasoner") or get_override_for_frontend_model("deepseek-r1")
    if not override:
        raise RuntimeError("未配置 deepseek-reasoner 模型")

    system_prompt = (
        "你是CFD多层审查官，负责液冷板传热模拟任务的质量把关。"
        "请针对给定的 CoolingPlate Intent JSON 依次完成物理层 Physics Check 与专家层 Expert Review。"
        "如果发现明显物理矛盾或缺项，允许在 JSON 中做必要修正，但必须遵循原有 Schema 字段，并保持 intent.profile 不变。"
        "所有分析、说明与提示请使用中文。"
    )
    schema_hint = json.dumps(schema, ensure_ascii=False)[:2000]
    user_prompt = (
        "【输入 Intent JSON】\n"
        f"{json.dumps(intent, ensure_ascii=False, indent=2)}\n\n"
        "【任务要求】\n"
        "1. Physics Check：结合几何尺寸、边界条件与材料，估算关键量（如雷诺数、体积流量、换热热流密度等），判断是否存在物理矛盾或缺失，并给出修正建议。\n"
        "2. Expert Review：从 CFD 专家的角度，梳理边界设置、数值策略、收敛/监控方案、潜在风险，并给出可执行的自动修正规则。\n"
        "3. 如需修改 Intent，仅调整必要字段，保持数值自洽，新增内容需注明原因。\n"
        "4. 输出严格 JSON 对象，字段结构如下：\n"
        "{\n"
        "  \"updated_intent\": <修正后的 Intent（若无修改则与输入一致）>,\n"
        "  \"physics_check\": {\"status\": \"pass/warn/fail\", \"summary\": \"\", \"issues\": [], \"key_calculations\": [], \"suggested_fixes\": []},\n"
        "  \"expert_review\": {\"summary\": \"\", \"boundary_guidance\": [], \"numerics_guidance\": [], \"risk_alerts\": [], \"auto_fix_rules\": []},\n"
        "  \"auto_corrections\": {\"applied\": [], \"rules\": []}\n"
        "}\n"
        "5. 若无可用信息，可返回空数组；数值估算请给出简短说明。\n"
        "【Schema 参考（截断预览）】\n"
        f"{schema_hint}\n"
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    return await call_llm_json_response(messages, override=override, force_json=True)

def _format_issue(issue: dict) -> str:
    if not isinstance(issue, dict):
        return str(issue)
    path = issue.get("path") or "?"
    message = issue.get("message") or ""
    return f"{path}：{message}".strip(":")

def _join_items(items, limit=3):
    if not isinstance(items, list):
        return ""
    filtered = [str(x).strip() for x in items if isinstance(x, (str, int, float)) and str(x).strip()]
    if not filtered:
        return ""
    return "；".join(filtered[:limit])

def build_multilayer_summary(
    schema_initial: Optional[Dict[str, object]],
    schema_final: Optional[Dict[str, object]],
    review: Dict[str, object],
    final_intent: dict,
    pipeline_status: str,
    storage_record: Optional[Dict[str, object]] = None,
) -> str:
    lines = ["【多层校验结果】"]
    schema_initial = schema_initial or {"valid": True, "issues": []}

    if not schema_initial.get("valid", False):
        lines.append("· Schema 校验：未通过。")
        for issue in (schema_initial.get("issues") or [])[:4]:
            lines.append(f"  - {_format_issue(issue)}")
        lines.append("请根据上述问题修改 Intent JSON 后重新生成。")
        return "\n".join(lines)

    lines.append("· Schema 校验：通过。")

    schema_final = schema_final or schema_initial
    if schema_final is not schema_initial:
        if schema_final.get("valid", False):
            lines.append("· 审查后 Schema 校验：通过（含自动修正）。")
        else:
            lines.append("· 审查后 Schema 校验：未通过。")
            for issue in (schema_final.get("issues") or [])[:4]:
                lines.append(f"  - {_format_issue(issue)}")
            lines.append("自动修正后的结果仍未通过 Schema 校验，请人工复核。")
    elif pipeline_status == "schema_regression":
        lines.append("· 审查后 Schema 校验：未通过，已保留模型输出供参考。")

    physics = review.get("physics") if isinstance(review, dict) else None
    if isinstance(physics, dict):
        status = physics.get("status") or physics.get("level") or "信息"
        summary = physics.get("summary") or physics.get("details") or physics.get("analysis") or "无详细说明。"
        lines.append(f"· 物理层（Physics Check）：[{status}] {summary}")
        issues_text = _join_items(physics.get("issues") or physics.get("concerns"))
        if issues_text:
            lines.append(f"  - 关注点：{issues_text}")
        calc_text = _join_items(physics.get("key_calculations"))
        if calc_text:
            lines.append(f"  - 关键计算：{calc_text}")
        fix_text = _join_items(physics.get("suggested_fixes"))
        if fix_text:
            lines.append(f"  - 修正建议：{fix_text}")
    elif pipeline_status == "reasoner_failed":
        lines.append("· 物理层（Physics Check）：未执行（审查模型调用失败）。")
    else:
        lines.append("· 物理层（Physics Check）：暂无模型反馈。")

    expert = review.get("expert") if isinstance(review, dict) else None
    if isinstance(expert, dict):
        summary = expert.get("summary") or expert.get("guidance") or "无总结。"
        lines.append(f"· 专家层（Expert Review）：{summary}")
        for key, label in [
            ("boundary_guidance", "边界设置"),
            ("numerics_guidance", "数值策略"),
            ("risk_alerts", "风险提示"),
            ("auto_fix_rules", "自动修正规则"),
        ]:
            text = _join_items(expert.get(key))
            if text:
                lines.append(f"  - {label}：{text}")
    elif pipeline_status == "reasoner_failed":
        lines.append("· 专家层（Expert Review）：未执行。")

    auto_corr = review.get("auto_corrections") if isinstance(review, dict) else None
    if isinstance(auto_corr, dict):
        applied = _join_items(auto_corr.get("applied"))
        if applied:
            lines.append(f"· 自动修正：{applied}")
        rules = _join_items(auto_corr.get("rules"))
        if rules:
            lines.append(f"  - 修正规则：{rules}")

    if isinstance(storage_record, dict):
        filename = str(storage_record.get("filename") or "").strip()
        path = str(storage_record.get("path") or "").strip()
        saved_line = filename or path
        if saved_line:
            lines.append(f"· 结果已保存：{saved_line}")
    
    if pipeline_status == "reasoner_failed" and isinstance(review, dict):
        err = review.get("reasoner_error")
        if err:
            lines.append(f"· 审查器提示：{err}")

    lines.append("【意图摘要】")
    lines.append(summarize_intent(final_intent))
    return "\n".join(lines)

# ---------- 路由 ----------
@app.get("/health")
def health():
    return {"ok": True, "service": "cfd-orchestrator-mini", "version": "0.5"}

@app.get("/intent/profiles")
def list_profiles():
    """供前端渲染“求解器”下拉：返回可用 profile 列表（不兜底）。"""
    items = []
    for slug, meta in PROFILE_REGISTRY.items():
        items.append({
            "slug": slug,
            "label": meta["label"],
            "family": meta["family"],
            "profile": meta["profile"],
            "default": slug == DEFAULT_PROFILE_SLUG
        })
    return {"items": items}

@app.get("/schemas/intent/{profile_slug}")
def get_schema_by_profile(profile_slug: str):
    meta = PROFILE_REGISTRY.get(profile_slug)
    if not meta:
        raise HTTPException(status_code=404, detail=f"unknown profile: {profile_slug}")
    try:
        schema = load_json(meta["schema"])
        template = load_json(meta["template"])
        return JSONResponse({"version": "v1.0", "profile": meta["profile"], "schema": schema, "template": template})
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Schema/Template not found: {e}")

@app.post("/intent/summary")
def intent_summary(payload: SummaryRequest):
    """根据 intent.profile 选择对应 schema 做校验，再生成摘要。"""
    prof_name = (payload.intent or {}).get("profile")
    if not prof_name:
        raise HTTPException(status_code=400, detail="缺少 intent.profile")
    meta = PROFILE_BY_NAME.get(prof_name)
    if not meta:
        raise HTTPException(status_code=400, detail=f"未知的 intent.profile：{prof_name}")

    try:
        schema = load_json(meta["schema"])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Schema not found: {e}")

    schema_result = format_schema_errors(schema_validate(payload.intent, schema))
    if not schema_result["valid"]:
        return JSONResponse(status_code=400, content={"valid": False, "issues": schema_result["issues"]})

    summary = summarize_intent(payload.intent)
    return JSONResponse({"valid": True, "human_summary": summary})

@app.post("/intent/fill_fast")
async def intent_fill_fast(req: FillFastRequest):
    meta = PROFILE_REGISTRY.get(req.profile_slug)
    if not meta:
        raise HTTPException(status_code=400, detail=f"未知的 profile_slug：{req.profile_slug}")

    try:
        template_raw = load_json(meta["template"])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Template not found: {e}")

    template_obj = template_raw if isinstance(template_raw, dict) else {}
    dimension_mode = normalize_dimension_mode(req.dimension_mode)
    prepared_template = apply_dimension_mode_to_template(template_obj, dimension_mode)

    override = None
    if req.model:
        override = get_override_for_frontend_model(req.model)
    if not override:
        override = get_override_for_frontend_model("deepseek-v1") or None

    try:
        llm_result = await call_llm_fill_fast(
            req.user_request,
            prepared_template,
            req.profile_slug,
            dimension_mode,
            override=override,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM 填写失败: {e}")

    if not isinstance(llm_result, dict):
        raise HTTPException(status_code=502, detail="LLM 返回非 JSON")

    llm_intent_raw = llm_result.get("intent")
    intent = merge_with_template(prepared_template, llm_intent_raw if isinstance(llm_intent_raw, dict) else {})
    intent["profile"] = meta["profile"]

    if isinstance(req.job_meta, dict):
        job_meta = intent.setdefault("job_meta", {}) if isinstance(intent.get("job_meta"), dict) else {}
        if not isinstance(job_meta, dict):
            job_meta = {}
        job_meta.update(req.job_meta)
        intent["job_meta"] = job_meta

    enforce_dimension_mode(intent, dimension_mode, prepared_template)

    defaults_used = coerce_string_list(llm_result.get("defaults_used"))
    open_questions = coerce_string_list(llm_result.get("open_questions"))

    geo = (
        (intent.get("meshing") or {})
        .get("blockMesh", {})
        .get("geometry", {})
    )
    effective_dimension = geo.get("dimension_mode") if isinstance(geo, dict) else None

    response = {
        "profile_slug": req.profile_slug,
        "family": meta["family"],
        "intent": intent,
        "defaults_used": defaults_used,
        "open_questions": open_questions,
        "dimension_mode": effective_dimension,
    }
    return JSONResponse(response)


@app.post("/intent/validate")
def intent_validate(req: ValidateIntentRequest):
    if not isinstance(req.intent, dict):
        raise HTTPException(status_code=400, detail="intent 必须为对象")

    meta = None
    if req.profile_slug:
        meta = PROFILE_REGISTRY.get(req.profile_slug)
    if not meta:
        profile_name = req.intent.get("profile")
        if profile_name:
            meta = PROFILE_BY_NAME.get(profile_name)
    if not meta:
        raise HTTPException(status_code=400, detail="无法识别 intent 对应的 profile")

    try:
        schema = load_json(meta["schema"])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Schema not found: {e}")

    result = format_schema_errors(schema_validate(req.intent, schema))
    profile_slug = req.profile_slug or meta.get("slug")
    if not profile_slug:
        for slug, meta_item in PROFILE_REGISTRY.items():
            if meta_item is meta:
                profile_slug = slug
                break
    payload = {"valid": result["valid"], "issues": result["issues"], "profile_slug": profile_slug}
    return JSONResponse(payload)


@app.post("/intent/save")
def intent_save(req: SaveIntentRequest):
    if not isinstance(req.intent, dict):
        raise HTTPException(status_code=400, detail="intent 必须为对象")

    meta = None
    if req.profile_slug:
        meta = PROFILE_REGISTRY.get(req.profile_slug)
    if not meta:
        profile_name = req.intent.get("profile")
        if profile_name:
            meta = PROFILE_BY_NAME.get(profile_name)
    if not meta:
        raise HTTPException(status_code=400, detail="无法识别 intent 对应的 profile")

    try:
        schema = load_json(meta["schema"])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Schema not found: {e}")

    intent_obj = deep_copy_json(req.intent)
    intent_obj["profile"] = meta["profile"]

    if isinstance(req.job_meta, dict):
        job_meta = intent_obj.setdefault("job_meta", {}) if isinstance(intent_obj.get("job_meta"), dict) else {}
        if not isinstance(job_meta, dict):
            job_meta = {}
        job_meta.update(req.job_meta)
        intent_obj["job_meta"] = job_meta

    validation = format_schema_errors(schema_validate(intent_obj, schema))
    if not validation["valid"]:
        return JSONResponse(status_code=400, content={"valid": False, "issues": validation["issues"]})

    try:
        saved_intent, job_id, relative_path, storage_path = save_intent_with_job_directory(intent_obj)
    except Exception as e:
        log.error("保存 Intent 文件失败：%s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"保存失败：{e}")

    profile_slug = req.profile_slug or meta.get("slug")
    if not profile_slug:
        for slug, meta_item in PROFILE_REGISTRY.items():
            if meta_item is meta:
                profile_slug = slug
                break
    if not profile_slug:
        profile_slug = DEFAULT_PROFILE_SLUG

    payload = {
        "ok": True,
        "job_id": job_id,
        "relative_path": relative_path,
        "storage_path": storage_path,
        "intent": saved_intent,
        "profile_slug": profile_slug,
    }
    return JSONResponse(payload)

@app.post("/intent/fill")
async def intent_fill(req: FillRequest):
    """根据用户输入驱动液冷板意图采集/校验流程。"""
    meta = PROFILE_REGISTRY.get(req.profile_slug)
    if not meta:
        raise HTTPException(status_code=400, detail=f"未知的 profile_slug：{req.profile_slug}")

    try:
        template = load_json(meta["template"]) if req.use_template else {}
        schema = load_json(meta["schema"])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Schema/Template not found: {e}")

    template_obj = template if isinstance(template, dict) else {}
    
    defaults_intent: Optional[dict] = None
    defaults_overview: Optional[Dict[str, Any]] = None
    missing_list: List[Dict[str, Any]] = []
    summary_hint = ""
    review_payload: Dict[str, Any] = {}
    pipeline_status = "ok"
    storage_record: Optional[Dict[str, Any]] = None
    
    if req.client_intent is None:
        collect_override = get_override_for_frontend_model("deepseek-v1")
        if req.model and req.model.startswith("deepseek"):
            collect_override = get_override_for_frontend_model(req.model) or collect_override
        try:
            collected = await call_llm_collect_parameters(
                req.user_request, template_obj, override=collect_override
            )
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"LLM 参数采集失败: {e}")

        collected_dict = collected if isinstance(collected, dict) else {}
        intent_raw = collected_dict.get("intent") if isinstance(collected_dict.get("intent"), dict) else {}
        intent = merge_with_template(template_obj, intent_raw if isinstance(intent_raw, dict) else {})
        intent["profile"] = meta["profile"]

        missing_list = normalize_missing_parameters(collected_dict.get("missing_parameters"))
        defaults_overview_raw = collected_dict.get("defaults_overview")
        defaults_overview = defaults_overview_raw if isinstance(defaults_overview_raw, dict) else None
        summary_hint = str(collected_dict.get("summary") or "").strip()

        default_intent_raw = collected_dict.get("default_intent")
        if isinstance(default_intent_raw, dict):
            defaults_intent = merge_with_template(template_obj, default_intent_raw)
            defaults_intent["profile"] = meta["profile"]

        if missing_list:
            pipeline_status = "needs_parameters"
            human_summary = build_collection_summary(missing_list, summary_hint)
            review_payload = {
                "stage": "collecting",
                "summary": summary_hint,
                "missing": missing_list,
                "defaults_overview": defaults_overview,
            }
            response: Dict[str, Any] = {
                "profile_slug": req.profile_slug,
                "family": meta["family"],
                "intent": intent,
                "human_summary": human_summary,
                "review": review_payload,
                "pipeline_status": pipeline_status,
                "missing_parameters": missing_list,
            }
            if defaults_intent:
                response["default_intent"] = defaults_intent
            if isinstance(defaults_overview, dict):
                response["defaults_overview"] = defaults_overview
            return JSONResponse(response)

        final_intent = deep_copy_json(intent)
    else:
        final_intent = merge_with_template(template_obj, req.client_intent)

    final_intent["profile"] = meta["profile"]

    schema_initial = format_schema_errors(schema_validate(final_intent, schema))
    review_payload = {"schema_initial": schema_initial}

    if not schema_initial["valid"]:
        pipeline_status = "schema_failed"
        human_summary = build_multilayer_summary(
            schema_initial, None, review_payload, final_intent, pipeline_status
        )
        response = {
            "profile_slug": req.profile_slug,
            "family": meta["family"],
            "intent": final_intent,
            "human_summary": human_summary,
            "review": review_payload,
            "pipeline_status": pipeline_status,
            "missing_parameters": [],
        }
        if defaults_intent:
            response["default_intent"] = defaults_intent
        if isinstance(defaults_overview, dict):
            response["defaults_overview"] = defaults_overview
        return JSONResponse(response)

    try:
        reasoner_raw = await call_reasoner_review(final_intent, meta, schema)
    except Exception as e:
        log.error("deepseek-reasoner 检查失败：%s", e, exc_info=True)
        pipeline_status = "reasoner_failed"
        review_payload["reasoner_error"] = str(e)
        human_summary = build_multilayer_summary(
            schema_initial, schema_initial, review_payload, final_intent, pipeline_status
        )
        response = {
            "profile_slug": req.profile_slug,
            "family": meta["family"],
            "intent": final_intent,
            "human_summary": human_summary,
            "review": review_payload,
            "pipeline_status": pipeline_status,
            "missing_parameters": [],
        }
        if defaults_intent:
            response["default_intent"] = defaults_intent
        if isinstance(defaults_overview, dict):
            response["defaults_overview"] = defaults_overview
        return JSONResponse(response)

    updated_intent = reasoner_raw.get("updated_intent") if isinstance(reasoner_raw, dict) else None
    if isinstance(updated_intent, dict):
        final_intent = deep_copy_json(updated_intent)
    final_intent["profile"] = meta["profile"]

    schema_final = format_schema_errors(schema_validate(final_intent, schema))
    review_payload.update({
        "schema_final": schema_final,
        "physics": reasoner_raw.get("physics_check") if isinstance(reasoner_raw, dict) else None,
        "expert": reasoner_raw.get("expert_review") if isinstance(reasoner_raw, dict) else None,
        "auto_corrections": reasoner_raw.get("auto_corrections") if isinstance(reasoner_raw, dict) else None,
    })

    if not schema_final["valid"]:
        pipeline_status = "schema_regression"

    human_summary = build_multilayer_summary(
        schema_initial,
        schema_final,
        review_payload,
        final_intent,
        pipeline_status,
        storage_record,
    )

    response = {
        "profile_slug": req.profile_slug,
        "family": meta["family"],
        "intent": final_intent,
        "human_summary": human_summary,
        "review": review_payload,
        "pipeline_status": pipeline_status,
        "missing_parameters": [],
    }
    if defaults_intent:
        response["default_intent"] = defaults_intent
    if isinstance(defaults_overview, dict):
        response["defaults_overview"] = defaults_overview

    return JSONResponse(response)
    
@app.post("/intent/apply")
def intent_apply(req: ApplyIntentRequest):
    intent = req.intent or {}
    profile_name = intent.get("profile")
    if not profile_name:
        raise HTTPException(status_code=400, detail="Intent 缺少 profile 字段")

    meta = PROFILE_BY_NAME.get(profile_name)
    if not meta:
        raise HTTPException(status_code=400, detail=f"未知的 intent.profile：{profile_name}")

    try:
        schema = load_json(meta["schema"])
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Schema not found: {e}")

    schema_result = format_schema_errors(schema_validate(intent, schema))
    if not schema_result["valid"]:
        first_issue = schema_result["issues"][0] if schema_result["issues"] else {}
        raise HTTPException(status_code=400, detail=f"Schema 校验失败：{_format_issue(first_issue)}")

    try:
        filename, path = save_intent_to_storage(intent, meta["slug"])
    except Exception as e:
        log.error("保存 Intent 文件失败：%s", e, exc_info=True)
        raise HTTPException(status_code=500, detail=f"保存失败：{e}")

    return {"ok": True, "filename": filename, "profile_slug": meta["slug"], "path": str(path)}
    
# 本地调试：python -m uvicorn server.app:app --reload
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server.app:app", host="0.0.0.0", port=8000, reload=False)
