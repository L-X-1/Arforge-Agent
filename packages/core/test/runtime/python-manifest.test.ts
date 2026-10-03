import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { GOLDEN_CASES } from "@arforge-ai/core/runtime/golden"

const python = Bun.which("python") ?? Bun.which("python3")

describe("Python formal manifest migration", () => {
  it("matches the legacy pricing scenario without creating a second result authority", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _pricing, builtin_formal_tasks
import json
import sys
sys.stdout.reconfigure(encoding="utf-8")
s = _pricing(1)
t = builtin_formal_tasks()[0]
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "task_id": t.task_id,
  "expected_files": t.expected_files,
  "timeout_steps": t.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly task_id: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["formal-pricing-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_pricing")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy inventory scenario source and verifier fixture", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _inventory
import json
import sys
sys.stdout.reconfigure(encoding="utf-8")
s = _inventory(1)
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "required_fragment": s.required_fragment,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly required_fragment: string
    }
    const migrated = GOLDEN_CASES["formal-inventory-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_inventory")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.fixture.content).toContain(legacy.required_fragment)
  })

  it("matches the legacy slug scenario source and truncation contract", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _slug, builtin_formal_tasks
import json
import sys
sys.stdout.reconfigure(encoding="utf-8")
s = _slug(1)
t = next(item for item in builtin_formal_tasks() if item.task_id == "formal-slug-01")
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "expected_files": t.expected_files,
  "timeout_steps": t.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["formal-slug-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_slug")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy retry scenario source and retry budget", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _retry, builtin_formal_tasks
import json
import sys
sys.stdout.reconfigure(encoding="utf-8")
s = _retry(1)
t = next(item for item in builtin_formal_tasks() if item.task_id == "formal-retry-01")
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "expected_files": t.expected_files,
  "timeout_steps": t.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["formal-retry-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_retry")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy state scenario and multi-file contract", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _state, _setup, builtin_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
s = _state(1)
root = Path(tempfile.mkdtemp())
_setup(s, 1, root)
t = next(item for item in builtin_formal_tasks() if item.task_id == "formal-state-01")
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "supporting": (root / "app/service_1.py").read_text(encoding="utf-8"),
  "expected_files": t.expected_files,
  "timeout_steps": t.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly supporting: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["formal-state-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_state")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.fixture.supportingFiles).toEqual([{ path: "app/service_1.py", content: legacy.supporting }])
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy refactor scenario and compatibility contract", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _refactor, builtin_formal_tasks
import json
import sys
sys.stdout.reconfigure(encoding="utf-8")
s = _refactor(1)
t = next(item for item in builtin_formal_tasks() if item.task_id == "formal-refactor-01")
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "expected_files": t.expected_files,
  "timeout_steps": t.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["formal-refactor-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_refactor")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy architecture scenario and import contract", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import _architecture, _setup, builtin_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
s = _architecture(1)
root = Path(tempfile.mkdtemp())
_setup(s, 1, root)
t = next(item for item in builtin_formal_tasks() if item.task_id == "formal-architecture-01")
print(json.dumps({
  "category": s.category,
  "prompt": s.prompt,
  "source": s.source,
  "tests": s.tests,
  "module": s.module,
  "supporting": (root / "app/store_1.py").read_text(encoding="utf-8"),
  "expected_files": t.expected_files,
  "timeout_steps": t.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly supporting: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["formal-architecture-01"]!
    expect(migrated.legacyTaskID).toBe(legacy.module)
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/formal_tasks.py::_architecture")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe(`app/${legacy.module}.py`)
    expect(migrated.fixture.supportingFiles).toEqual([{ path: "app/store_1.py", content: legacy.supporting }])
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy multistack JavaScript setup and complete fixture", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.multistack_formal_tasks import SCENARIOS, _prompt, _setup_javascript, builtin_multistack_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
scenario = next(item for item in SCENARIOS if item.stack_id == "javascript")
root = Path(tempfile.mkdtemp())
_setup_javascript(root, 51, 101)
task = next(item for item in builtin_multistack_formal_tasks() if item.task_id == "multistack-javascript-01")
print(json.dumps({
  "category": task.category,
  "prompt": _prompt(scenario, 51),
  "source": (root / "src/policy.js").read_text(encoding="utf-8"),
  "tests": (root / "tests/contract.test.js").read_text(encoding="utf-8"),
  "package": (root / "package.json").read_text(encoding="utf-8"),
  "service": (root / "src/service.js").read_text(encoding="utf-8"),
  "expected_files": task.expected_files,
  "timeout_steps": task.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly package: string
      readonly service: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["multistack-javascript-01"]!
    expect(migrated.legacyTaskID).toBe("multistack-javascript-01")
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/multistack_formal_tasks.py::_setup_javascript(51,101)")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe("src/policy.js")
    expect(migrated.fixture.supportingFiles).toEqual([
      { path: "package.json", content: legacy.package },
      { path: "src/service.js", content: legacy.service },
    ])
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy multistack Java setup and complete fixture", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.multistack_formal_tasks import SCENARIOS, _prompt, _setup_java, builtin_multistack_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
scenario = next(item for item in SCENARIOS if item.stack_id == "java")
root = Path(tempfile.mkdtemp())
_setup_java(root, 51, 101)
task = next(item for item in builtin_multistack_formal_tasks() if item.task_id == "multistack-java-01")
print(json.dumps({
  "category": task.category,
  "prompt": _prompt(scenario, 51),
  "source": (root / "src/Policy.java").read_text(encoding="utf-8"),
  "tests": (root / "tests/ContractTest.java").read_text(encoding="utf-8"),
  "service": (root / "src/ScoreService.java").read_text(encoding="utf-8"),
  "expected_files": task.expected_files,
  "timeout_steps": task.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly service: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["multistack-java-01"]!
    expect(migrated.legacyTaskID).toBe("multistack-java-01")
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.source).toBe("arforge/eval/multistack_formal_tasks.py::_setup_java(51,101)")
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.fixture.path).toBe("src/Policy.java")
    expect(migrated.fixture.supportingFiles).toEqual([{ path: "src/ScoreService.java", content: legacy.service }])
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })

  it("matches the legacy Rust, C, C++, and C# complete fixtures", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.multistack_formal_tasks import SCENARIOS, _prompt, _setup_rust, _setup_c, _setup_cpp, _setup_csharp, builtin_multistack_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
configs = [
  ("rust", _setup_rust, "src/lib.rs", "tests/contract.rs", "Cargo.toml"),
  ("c", _setup_c, "src/policy.c", "tests/contract.c", "include/policy.h"),
  ("cpp", _setup_cpp, "src/policy.cpp", "tests/contract.cpp", "include/policy.hpp"),
  ("csharp", _setup_csharp, "Policy.cs", "Program.cs", "Acceptance.csproj"),
]
out = {}
for stack_id, setup, source_path, tests_path, supporting_path in configs:
    scenario = next(item for item in SCENARIOS if item.stack_id == stack_id)
    root = Path(tempfile.mkdtemp())
    setup(root, 51, 101)
    task = next(item for item in builtin_multistack_formal_tasks() if item.task_id == f"multistack-{stack_id}-01")
    out[stack_id] = {
      "category": task.category,
      "prompt": _prompt(scenario, 51),
      "source": (root / source_path).read_text(encoding="utf-8"),
      "tests": (root / tests_path).read_text(encoding="utf-8"),
      "supporting": (root / supporting_path).read_text(encoding="utf-8"),
      "expected_files": task.expected_files,
      "timeout_steps": task.timeout_steps,
    }
print(json.dumps(out, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly supporting: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }>
    const cases = [
      { stackID: "rust", caseID: "multistack-rust-01", sourcePath: "src/lib.rs", supportingPath: "Cargo.toml" },
      { stackID: "c", caseID: "multistack-c-01", sourcePath: "src/policy.c", supportingPath: "include/policy.h" },
      { stackID: "cpp", caseID: "multistack-cpp-01", sourcePath: "src/policy.cpp", supportingPath: "include/policy.hpp" },
      { stackID: "csharp", caseID: "multistack-csharp-01", sourcePath: "Policy.cs", supportingPath: "Acceptance.csproj" },
    ] as const
    for (const entry of cases) {
      const item = legacy[entry.stackID]!
      const migrated = GOLDEN_CASES[entry.caseID]!
      expect(migrated.legacyTaskID).toBe(entry.caseID)
      expect(migrated.legacyCategory).toBe(item.category)
      expect(migrated.objective).toBe(item.prompt)
      expect(migrated.fixture.content).toBe(item.source)
      expect(migrated.fixture.tests).toBe(item.tests)
      expect(migrated.fixture.path).toBe(entry.sourcePath)
      expect(migrated.fixture.supportingFiles).toEqual([{ path: entry.supportingPath, content: item.supporting }])
      expect(migrated.legacyExpectedFiles).toEqual(item.expected_files)
      expect(migrated.legacyTimeoutSteps).toBe(item.timeout_steps)
    }
  })

  it("matches unavailable Go, PHP, and Ruby fixtures without claiming runtime execution", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.multistack_formal_tasks import SCENARIOS, _prompt, _setup_go, _setup_php, _setup_ruby, builtin_multistack_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
configs = [
  ("go", _setup_go, "policy/policy.go", "service/contract_test.go", ["go.mod", "service/service.go"]),
  ("php", _setup_php, "src/Policy.php", "tests/contract.php", []),
  ("ruby", _setup_ruby, "lib/policy.rb", "tests/contract_test.rb", []),
]
out = {}
for stack_id, setup, source_path, tests_path, supporting_paths in configs:
    scenario = next(item for item in SCENARIOS if item.stack_id == stack_id)
    root = Path(tempfile.mkdtemp())
    setup(root, 51, 101)
    task = next(item for item in builtin_multistack_formal_tasks() if item.task_id == f"multistack-{stack_id}-01")
    out[stack_id] = {
      "category": task.category,
      "prompt": _prompt(scenario, 51),
      "source": (root / source_path).read_text(encoding="utf-8"),
      "tests": (root / tests_path).read_text(encoding="utf-8"),
      "supporting": [{"path": path, "content": (root / path).read_text(encoding="utf-8")} for path in supporting_paths],
      "expected_files": task.expected_files,
      "timeout_steps": task.timeout_steps,
    }
print(json.dumps(out, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as Record<string, {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly supporting: ReadonlyArray<{ readonly path: string; readonly content: string }>
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }>
    const cases = [
      { stackID: "go", caseID: "multistack-go-01" },
      { stackID: "php", caseID: "multistack-php-01" },
      { stackID: "ruby", caseID: "multistack-ruby-01" },
    ] as const
    for (const entry of cases) {
      const item = legacy[entry.stackID]!
      const migrated = GOLDEN_CASES[entry.caseID]!
      expect(migrated.legacyTaskID).toBe(entry.caseID)
      expect(migrated.legacyCategory).toBe(item.category)
      expect(migrated.objective).toBe(item.prompt)
      expect(migrated.fixture.content).toBe(item.source)
      expect(migrated.fixture.tests).toBe(item.tests)
      expect(migrated.fixture.supportingFiles ?? []).toEqual(item.supporting)
      expect(migrated.legacyExpectedFiles).toEqual(item.expected_files)
      expect(migrated.legacyTimeoutSteps).toBe(item.timeout_steps)
    }
  })

  it("matches all 50 Python formal builders against the TS manifest", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.formal_tasks import BUILDERS, FAMILY_COUNTS, _setup, builtin_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
tasks = builtin_formal_tasks()
out = []
for builder in BUILDERS:
    family = builder(1).family
    for index in range(1, FAMILY_COUNTS[family] + 1):
        scenario = builder(index)
        task = next(item for item in tasks if item.task_id == f"formal-{family}-{index:02d}")
        root = Path(tempfile.mkdtemp())
        _setup(scenario, index, root)
        supporting = []
        for path in [f"app/service_{index}.py", f"app/store_{index}.py"]:
            candidate = root / path
            if candidate.is_file():
                supporting.append({"path": path, "content": candidate.read_text(encoding="utf-8")})
        out.append({
          "family": family,
          "index": index,
          "category": scenario.category,
          "prompt": scenario.prompt,
          "source": scenario.source,
          "tests": scenario.tests,
          "module": scenario.module,
          "supporting": supporting,
          "expected_files": task.expected_files,
          "timeout_steps": task.timeout_steps,
        })
print(json.dumps(out, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as ReadonlyArray<{
      readonly family: string
      readonly index: number
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly module: string
      readonly supporting: ReadonlyArray<{ readonly path: string; readonly content: string }>
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }>
    expect(legacy).toHaveLength(50)
    const migrated = Object.values(GOLDEN_CASES).filter((goldenCase) => goldenCase.sourceFamily === "python-formal")
    expect(migrated).toHaveLength(50)
    for (const item of legacy) {
      const caseID = `formal-${item.family}-${String(item.index).padStart(2, "0")}`
      const goldenCase = GOLDEN_CASES[caseID]!
      expect(goldenCase.legacyTaskID).toBe(item.module)
      expect(goldenCase.legacyCategory).toBe(item.category)
      expect(goldenCase.objective).toBe(item.prompt)
      expect(goldenCase.fixture.source).toBe(`arforge/eval/formal_tasks.py::_${item.family}`)
      expect(goldenCase.fixture.content).toBe(item.source)
      expect(goldenCase.fixture.tests).toBe(item.tests)
      expect(goldenCase.fixture.path).toBe(`app/${item.module}.py`)
      expect(goldenCase.fixture.supportingFiles ?? []).toEqual(item.supporting)
      expect(goldenCase.legacyExpectedFiles).toEqual(item.expected_files)
      expect(goldenCase.legacyTimeoutSteps).toBe(item.timeout_steps)
    }
  })

  it("matches all 26 Python capability-eval contracts against the TS manifest", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.core.capability_eval import builtin_capability_eval_tasks
import json
import sys
sys.stdout.reconfigure(encoding="utf-8")
print(json.dumps([
  {
    "id": task.id,
    "category": task.category,
    **task.migration_contract,
  }
  for task in builtin_capability_eval_tasks()
], ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as ReadonlyArray<{
      readonly id: string
      readonly category: string
      readonly objective: string
      readonly source: string
      readonly path: string
      readonly content: string
      readonly tests: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
      readonly positive_assertions: ReadonlyArray<string>
      readonly negative_assertions: ReadonlyArray<string>
    }>
    expect(legacy).toHaveLength(26)
    const migrated = Object.values(GOLDEN_CASES).filter((goldenCase) => goldenCase.sourceFamily === "capability-eval")
    expect(migrated).toHaveLength(26)
    for (const item of legacy) {
      const goldenCase = GOLDEN_CASES[item.id]!
      expect(goldenCase.legacyTaskID).toBe(item.id)
      expect(goldenCase.legacyCategory).toBe(item.category)
      expect(goldenCase.objective).toBe(item.objective)
      expect(goldenCase.fixture.source).toBe(item.source)
      expect(goldenCase.fixture.path).toBe(item.path)
      expect(goldenCase.fixture.content).toBe(item.content)
      expect(goldenCase.fixture.tests).toBe(item.tests)
      expect(goldenCase.legacyExpectedFiles).toEqual(item.expected_files)
      expect(goldenCase.legacyTimeoutSteps).toBe(item.timeout_steps)
      expect(goldenCase.positiveAssertions.map((assertion) => assertion.id)).toEqual([...item.positive_assertions])
      expect(goldenCase.negativeAssertions.map((assertion) => assertion.id)).toEqual([...item.negative_assertions])
    }
  })

  it("matches all 50 multistack builders against the TS manifest", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.multistack_formal_tasks import SCENARIOS, builtin_multistack_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
tasks = builtin_multistack_formal_tasks()
out = []
for scenario in SCENARIOS:
    for index in range(1, 6):
        threshold = 48 + index * 3
        maximum = 100 + index
        root = Path(tempfile.mkdtemp())
        scenario.setup(root, threshold, maximum)
        task = next(item for item in tasks if item.task_id == f"multistack-{scenario.stack_id}-{index:02d}")
        files = []
        for path in sorted(root.rglob("*")):
            if path.is_file():
                relative = path.relative_to(root).as_posix()
                if relative not in task.expected_files:
                    files.append({"path": relative, "content": path.read_text(encoding="utf-8")})
        out.append({
          "task_id": task.task_id,
          "category": task.category,
          "prompt": task.prompt,
          "expected_files": task.expected_files,
          "timeout_steps": task.timeout_steps,
          "files": files,
        })
print(json.dumps(out, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as ReadonlyArray<{
      readonly task_id: string
      readonly category: string
      readonly prompt: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
      readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>
    }>
    expect(legacy).toHaveLength(50)
    const migrated = Object.values(GOLDEN_CASES).filter((goldenCase) => goldenCase.sourceFamily === "multistack")
    expect(migrated).toHaveLength(50)
    for (const item of legacy) {
      const goldenCase = GOLDEN_CASES[item.task_id]!
      expect(goldenCase.legacyTaskID).toBe(item.task_id)
      expect(goldenCase.legacyCategory).toBe(item.category)
      expect(goldenCase.objective).toBe(item.prompt)
      expect(goldenCase.legacyExpectedFiles).toEqual(item.expected_files)
      expect(goldenCase.legacyTimeoutSteps).toBe(item.timeout_steps)
      const testFile = item.files.find((file) => file.content === goldenCase.fixture.tests)
      expect(testFile, item.task_id).toBeDefined()
      const fixtureFiles = [
        { path: goldenCase.fixture.path, content: goldenCase.fixture.content },
        ...(goldenCase.fixture.supportingFiles ?? []),
        ...(testFile === undefined ? [] : [{ path: testFile.path, content: goldenCase.fixture.tests }]),
      ].sort((left, right) => left.path.localeCompare(right.path))
      expect(fixtureFiles).toEqual(Array.from(item.files))
    }
  })

  it("matches the legacy multistack SQL setup and expected regression contract", () => {
    expect(python).not.toBeNull()
    if (python === null) return
    const script = `
from arforge.eval.multistack_formal_tasks import SCENARIOS, _prompt, _setup_sql, builtin_multistack_formal_tasks
from pathlib import Path
import json
import sys
import tempfile
sys.stdout.reconfigure(encoding="utf-8")
scenario = next(item for item in SCENARIOS if item.stack_id == "sql")
root = Path(tempfile.mkdtemp())
_setup_sql(root, 51, 101)
task = next(item for item in builtin_multistack_formal_tasks() if item.task_id == "multistack-sql-01")
print(json.dumps({
  "category": task.category,
  "prompt": _prompt(scenario, 51),
  "source": (root / "src/schema.sql").read_text(encoding="utf-8"),
  "tests": (root / "tests/contract.sql").read_text(encoding="utf-8"),
  "expected_files": task.expected_files,
  "timeout_steps": task.timeout_steps,
}, ensure_ascii=False))
`
    const result = Bun.spawnSync([python, "-c", script], {
      cwd: resolve(process.cwd(), "..", ".."),
    })
    expect(result.exitCode).toBe(0)
    const legacy = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      readonly category: string
      readonly prompt: string
      readonly source: string
      readonly tests: string
      readonly expected_files: ReadonlyArray<string>
      readonly timeout_steps: number
    }
    const migrated = GOLDEN_CASES["multistack-sql-01"]!
    expect(migrated.legacyTaskID).toBe("multistack-sql-01")
    expect(migrated.legacyCategory).toBe(legacy.category)
    expect(migrated.objective).toBe(legacy.prompt)
    expect(migrated.fixture.content).toBe(legacy.source)
    expect(migrated.fixture.tests).toBe(legacy.tests)
    expect(migrated.legacyExpectedFiles).toEqual(legacy.expected_files)
    expect(migrated.legacyTimeoutSteps).toBe(legacy.timeout_steps)
  })
})
