# /home/dyfluid/work/Foam-Agent/bridge.py
import os, uuid, subprocess, threading, time, shutil
from pathlib import Path
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request
from fastapi.middleware.cors import CORSMiddleware

FOAM_AGENT_ROOT = Path("/home/dyfluid/work/Foam-Agent").resolve()
RUNS_DIR        = FOAM_AGENT_ROOT / "runs"
OUTPUT_ROOT     = FOAM_AGENT_ROOT / "output"
OPENFOAM_PATH   = os.environ.get("WM_PROJECT_DIR", "/home/dyfluid/OpenFOAM/OpenFOAM-10")

app = FastAPI(title="Foam-Agent Bridge", version="1.0.0")
# 允许你本机前端 http://localhost:8000 跨域访问
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

JOBS = {}   # {job_id: {...状态...}}

def zip_dir(src_dir: Path, zip_path: Path):
    if zip_path.exists(): zip_path.unlink()
    shutil.make_archive(zip_path.with_suffix(""), "zip", src_dir)

def _run_job(job_id: str):
    job = JOBS[job_id]
    workdir   = Path(job["workdir"])
    outdir    = Path(job["outdir"])
    logfile   = Path(job["logfile"])

    cmd = [
        "python", "foambench_main.py",
        "--openfoam_path", OPENFOAM_PATH,
        "--output", str(outdir),
        "--prompt_path", str(workdir / "user_requirement.txt")
    ]
    
    mesh_rel_path = job.get("mesh_rel_path")
    if mesh_rel_path:
        cmd.extend(["--custom_mesh_path", str(mesh_rel_path)])
    with open(logfile, "wb") as logf:
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(FOAM_AGENT_ROOT),
                stdout=logf, stderr=subprocess.STDOUT, env=os.environ.copy()
            )
            JOBS[job_id]["state"] = "running"
            JOBS[job_id]["started_at"] = time.time()
            JOBS[job_id]["pid"] = proc.pid
            ret = proc.wait()
            JOBS[job_id]["returncode"] = ret
            if ret == 0:
                # 打包 zip
                zip_path = OUTPUT_ROOT / f"{job_id}.zip"
                zip_dir(outdir, zip_path)
                JOBS[job_id]["zip"]   = str(zip_path)
                JOBS[job_id]["state"] = "finished"
                JOBS[job_id]["finished_at"] = time.time()
                JOBS[job_id]["error"] = None
            else:
                JOBS[job_id]["state"] = "failed"
                JOBS[job_id]["finished_at"] = time.time()
                JOBS[job_id]["error"] = f"Process exited with code {ret}"
        except Exception as e:
            JOBS[job_id]["state"] = "failed"
            JOBS[job_id]["error"] = str(e)
            JOBS[job_id]["finished_at"] = time.time()

@app.get("/health")
def health():
    return {"ok": True, "wm_project_dir": OPENFOAM_PATH}

@app.post("/run")
async def run(
    request: Request,
    requirement: str | None = Form(default=None),
    case_name: str | None = Form(default=None),
    mesh: UploadFile | None = File(default=None)
):
    raw_requirement = requirement
    raw_case_name = case_name

    if raw_requirement is None:
        try:
            payload = await request.json()
        except Exception:
            payload = None
        if isinstance(payload, dict):
            raw_requirement = payload.get("requirement")
            if raw_case_name is None and payload.get("case_name") is not None:
                raw_case_name = payload.get("case_name")

    requirement_text = (str(raw_requirement).strip() if raw_requirement is not None else "")
    if not requirement_text:
        raise HTTPException(400, "Empty requirement")
    
    case_name_text = str(raw_case_name).strip() if raw_case_name is not None else ""

    job_id = uuid.uuid4().hex[:12]
    workdir = RUNS_DIR / job_id
    outdir  = OUTPUT_ROOT / job_id
    workdir.mkdir(parents=True, exist_ok=True)
    outdir.mkdir(parents=True, exist_ok=True)

    # 写 user_requirement.txt（Foam-Agent 将读取它）
    (workdir / "user_requirement.txt").write_text(requirement_text, encoding="utf-8")

    mesh_rel_path = None
    mesh_filename = None
    if mesh is not None:
        mesh_filename = mesh.filename or "uploaded.msh"
        ext = Path(mesh_filename).suffix.lower()
        if ext != ".msh":
            try:
                mesh.file.close()
            except Exception:
                pass
            raise HTTPException(400, "Only .msh mesh files are supported")

        dest_path = workdir / "my.msh"
        try:
            mesh.file.seek(0)
        except Exception:
            pass
        with dest_path.open("wb") as f:
            shutil.copyfileobj(mesh.file, f)
        try:
            mesh.file.close()
        except Exception:
            pass
        mesh_rel_path = Path("runs") / job_id / "my.msh"

    JOBS[job_id] = {
        "state": "queued",
        "created_at": time.time(),
        "workdir": str(workdir),
        "outdir":  str(outdir),
        "logfile": str(workdir / "run.log"),
        "zip": None,
        "returncode": None,
        "case_name": case_name_text or "",
        "started_at": None,
        "finished_at": None,
        "error": None,
        "mesh_rel_path": str(mesh_rel_path) if mesh_rel_path else None,
        "mesh_filename": mesh_filename,
    }

    t = threading.Thread(target=_run_job, args=(job_id,), daemon=True)
    t.start()
    return {"job_id": job_id}

@app.get("/status/{job_id}")
def status(job_id: str):
    job = JOBS.get(job_id)
    if not job: raise HTTPException(404, "job not found")
    # 读尾部日志
    tail = ""
    log = Path(job["logfile"])
    if log.exists():
        try:
            tail = log.read_text(encoding="utf-8", errors="ignore")[-2000:]
        except Exception:
            tail = ""
    return {
        "state": job["state"],
        "returncode": job["returncode"],
        "log_tail": tail,
        "zip": job["zip"],
        "created_at": job["created_at"],
        "case_name": job["case_name"],
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "pid": job.get("pid"),
        "error": job.get("error"),
        "mesh_filename": job.get("mesh_filename"),
        "mesh_path": job.get("mesh_rel_path"),
    }

from fastapi.responses import FileResponse
@app.get("/download/{job_id}")
def download(job_id: str):
    job = JOBS.get(job_id)
    if not job or not job.get("zip"): raise HTTPException(404, "no zip")
    return FileResponse(
        path=job["zip"], filename=f"{job_id}.zip",
        media_type="application/zip"
    )
