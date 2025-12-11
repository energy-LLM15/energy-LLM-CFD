

# CFDAgent: LLM-Driven Autonomous CFD Platform for OpenFOAM

> From natural-language problem descriptions to converged OpenFOAM simulations and neural surrogates — with minimal human intervention. 

CFDAgent is a research-grade framework that couples large language model (LLM) agents, retrieval-augmented knowledge bases, reinforcement learning and neural surrogates into a **self-improving CFD workflow**.

Starting from a short text description and optional CAD files, the system automatically:

* normalizes and validates inputs (units, dimensions, boundary conditions),
* generates consistent OpenFOAM case directories,
* runs and monitors simulations on a cluster,
* repairs failed runs in closed loop, and
* learns from every success/failure via an experience memory and offline “digital twins”.

The implementation follows the methodology described in the accompanying manuscript and is intended as a **reproducible reference implementation** for LLM-CFD research and energy-related thermal–fluid simulations. 

---

## ✨ Key Features

* **Natural-language → OpenFOAM pipeline**

  * Users specify cases via simple text and a small form/JSON file.
  * The system performs unit parsing, dimensional checks and minimal-completeness checks before any solver is touched.

* **Multi-index Retrieval-Augmented Knowledge Fabric**

  * Separate indices for tutorials, dictionaries, error–fix recipes and private project repositories.
  * Hybrid dense + sparse retrieval with reliability re-weighting from past executions.

* **MoE + Attention LLM Core**

  * Domain-tuned LLM that outputs both engineering chain-of-thought (plans) and syntactically strict OpenFOAM dictionaries.
  * Constrained decoding to guarantee cross-file consistency (patch names, solver choices, units, etc.).

* **Self-Improvement Loop (Supervised + RL)**

  * Treats the whole “configure → run → debug” process as a Markov decision process.
  * Learns to adjust solver settings, time step, relaxation factors and discretisation schemes based on log diagnostics.

* **Experience Memory & Offline Neural Twins**

  * Every “configuration–log–fix–result” trajectory is stored as reusable experience.
  * Neural surrogates (diffusion/neural operator–style) provide millisecond-level approximations to CFD fields for tasks like liquid cooling plate design.

* **Cluster-Friendly Architecture**

  * OpenFOAM runs are containerised and submitted through Slurm/PBS-like schedulers.
  * LLM inference and CFD computation are cleanly separated, enabling horizontal scaling.

> In internal benchmarks, the framework achieves high execution success rates and ~10³-fold speedups for selected surrogate-enabled workflows, while reducing token usage and outer-loop iterations compared with existing LLM-CFD baselines. 

---

---

## 🛠️ Installation

### 1. System Requirements

* **Python** ≥ 3.9 (recommended 3.10+)
* **OpenFOAM** v9+ or v10+ installed and accessible in your shell
* A working C/C++ compiler (for OpenFOAM)
* Optional: Slurm/PBS or similar scheduler for cluster mode
* Optional: NVIDIA GPU + CUDA for training surrogates / running LLMs locally

### 2. Create Environment

Using conda (recommended):

```bash
conda create -n cfdagent python=3.10 -y
conda activate cfdagent
```

Or with venv:

```bash
python -m venv .venv
source .venv/bin/activate    # Windows: .venv\Scripts\activate
```

### 3. Install Python Dependencies

You can either install from `requirements.txt`:

```bash
pip install -r requirements.txt
```

or install the core packages manually:

```bash
pip install \
  numpy scipy pandas \
  pydantic[dotenv] pyyaml typer rich loguru \
  requests httpx \
  torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121 \
  transformers accelerate sentence-transformers \
  faiss-cpu \
  scikit-learn \
  fastapi uvicorn[standard] \
  nltk spacy \
  python-dotenv \
  matplotlib
```

If you are using OpenAI/DeepSeek or other LLM APIs, also install the corresponding SDKs, e.g.:

```bash
pip install openai
# or any other vendor-specific client
```

> ⚠️ Note: adjust the PyTorch install line to your CUDA/CPU environment.

---

## ⚙️ Basic Configuration

Create a config file `config.yaml` in the project root:

```yaml
openfoam:
  foam_exec: "/opt/openfoam10/bin"
  foam_version: "10"
  case_root: "/data/cfd_cases"

llm:
  provider: "openai"              # or "deepseek", "local"
  model_name: "gpt-4.1"           # or your finetuned MoE model ID
  max_tokens: 4096
  temperature: 0.2

rag:
  index_dir: "./indices"
  top_k: 5
  enable_reliability_weight: true

scheduler:
  backend: "slurm"                # "local" / "slurm" / "pbs"
  partition: "compute"
  default_cores: 32

surrogates:
  enable: true
  model_dir: "./surrogates"
```

---

## 🚀 Quick Start

### 1. Build Knowledge Indices

```bash
python scripts/build_index.py \
  --docs ./data/docs \
  --cases ./data/tutorial_cases \
  --output ./indices
```

This step ingests:

* official OpenFOAM tutorials,
* your own project repositories,
* error–fix logs,

and builds a multi-index RAG store that the agents will query.

### 2. Run a Simple Case from Natural Language

```bash
python scripts/run_case.py \
  --task "Simulate incompressible turbulent flow in a 3D backward-facing step at Re=5000, air at 300 K, compute mean pressure drop and reattachment length." \
  --output ./runs/bfs_re5000
```

What happens internally:

1. **Frontend**

   * parses the task, extracts units and parameters,
   * builds a strongly typed JSON schema and checks dimensional consistency.

2. **Knowledge Fabric + LLM Agents**

   * retrieves similar cases/templates from the indices,
   * Architect + Writer generate `blockMeshDict`, `controlDict`, `fvSchemes`, `fvSolution`, `0/*` fields, and an `Allrun` script.

3. **Runner + Reviewer**

   * executes the case using OpenFOAM,
   * monitors residuals/Courant numbers and parses logs,
   * if necessary, automatically edits numerics and reruns.

4. **Memory + Surrogates (optional)**

   * stores “configuration–log–fix–result” into the experience library,
   * surrogates can be queried later for fast approximations.

### 3. Launch Web Frontend (Optional)

If you implemented a FastAPI/React front-end:

```bash
uvicorn cfdagent.api:app --host 0.0.0.0 --port 8000 --reload
```

Open `http://localhost:8000` (or your deployed URL) to use the browser UI for:

* natural-language problem entry,
* CAD/STP upload,
* live convergence monitoring and result download.

---

## 🧪 Training Neural Surrogates (Example: Liquid Cooling Plate)

To train a surrogate on a dataset of CFD runs:

```bash
python scripts/train_surrogate.py \
  --data ./data/cooling_plate \
  --output ./surrogates/cooling_plate.pt \
  --epochs 200 \
  --batch-size 16
```

After training, CFDAgent can:

* predict velocity/pressure/temperature fields in **tens of milliseconds**,
* estimate key QoIs (Δp, Tmax, temperature uniformity) for rapid design screening,
* use the surrogate as an offline “digital twin” to guide the RL policy and reduce failed CFD runs. 

---

## 📊 Typical Use Cases

* Autonomous setup and execution of:

  * internal/external flows (ducts, cylinders, airfoils),
  * heat-transfer and conjugate heat-transfer problems,
  * multiphase flows (VOF, free-surface, liquid films).

* High-throughput parametric studies:

  * geometry variations,
  * operating condition sweeps,
  * multi-objective optimisation with surrogates in the loop.

* Teaching & onboarding:

  * lowering the barrier for new CFD users,
  * providing “executable examples” driven by natural language instead of hand-written dictionaries.

---

## 📚 Citation

If you use this codebase or parts of it in academic work, please cite the accompanying manuscript:

```text
Z. Liu, L. Yin, T. Zhu, J. Huang, "CFDAgent: an LLM-driven self-improving framework with neural twins for energy-related thermal-fluid simulations", 2025.
Tongji University

---

## 📜 License

Choose an appropriate license for your repo, e.g.:

* `MIT` for permissive use, or
* `GPL-3.0` if you want copyleft for derivatives, or
* `Apache-2.0` if you need explicit patent grants.

---

