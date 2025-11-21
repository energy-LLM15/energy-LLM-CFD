// js/config/modelPresets.js
//
// 仅保留：1) 本机 FastAPI 桥接配置；
// 为防其他模块仍 import ORCHESTRATOR_API，这里导出一个空占位，避免运行时报错。
export const ORCHESTRATOR_API = null;

/** FastAPI 桥接 (宿主机，经 NAT 转到虚机 8080) */
export const BRIDGE_API = {
  /** 你已在宿主启动了端口映射到虚机: http://localhost:18080 -> 192.168.157.129:8080 */
  baseUrl: "http://localhost:18080",
  paths: {
    health: "/health",            // GET
    run: "/run",                  // POST
    status: "/status",            // GET /status/:job_id
    download: "/download"         // GET /download/:job_id
  },
  /** 结合你提供的真实路径，作为前端传给桥接的默认参数 */
  defaults: {
    openfoam_path: "/home/dyfluid/OpenFOAM/OpenFOAM-10",   // $WM_PROJECT_DIR
    prompt_path: "/home/dyfluid/work/Foam-Agent/user_requirement.txt",
    output_dir: "/home/dyfluid/work/Foam-Agent/output"
  }
};

export const MODEL_PRESETS = [
  {
	id: "",
    label: "",
    request: {
      baseUrl: "",
      path: "",
      model: "",
      apiKey: "", // 
      params: { temperature: 0.2 }
    }
  },
  {
	id: "",
    label: "",
    hidden: true,
    request: {
      baseUrl: "",
      path: "",
      model: "",
      apiKey: "",
      params: { temperature: 0.1, reasoning: { effort: "medium" } }
    }
  }
];

export function getModelConfig(modelId) {
  return MODEL_PRESETS.find((p) => p.id === modelId) ?? MODEL_PRESETS[0] ?? null;
}
