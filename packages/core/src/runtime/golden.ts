import { Effect, Schema, Stream } from "effect"
import {
  LLMEvent,
  LLMResponse,
  type LLMClientShape,
  type LLMEvent as LLMEventType,
  type LLMRequest,
} from "@arforge-ai/llm"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { digest, RuntimeInsight } from "./insight"
import { verify, type VerificationCheckInput } from "./verifier"
import type { CreateInput as EvaluationCreateInput } from "./evaluation"

export type ReplayKind =
  | "pure-reducer"
  | "recorded-provider"
  | "deterministic-tool-fixture"
  | "live-model"
  | "desktop-e2e"

export type Assertion = {
  readonly id: string
  readonly kind: "equals" | "contains" | "not_contains"
  readonly actualKey: string
  readonly expected: string | number | boolean
}

export interface GoldenFixtureFile {
  readonly path: string
  readonly content: string
}

export interface GoldenFixture {
  readonly source: string
  readonly language: string
  readonly path: string
  readonly content: string
  readonly tests: string
  /** Additional immutable files required by a multi-file legacy task. */
  readonly supportingFiles?: ReadonlyArray<GoldenFixtureFile>
}

const freezeFixtureFiles = (files: ReadonlyArray<GoldenFixtureFile>): ReadonlyArray<GoldenFixtureFile> =>
  Object.freeze(files.map((file) => Object.freeze({ ...file })))

export interface GoldenCase {
  readonly suiteID: string
  readonly suiteRevision: number
  readonly caseID: string
  readonly caseRevision: number
  readonly legacyTaskID: string
  readonly legacyCategory: string
  readonly legacyExpectedFiles: ReadonlyArray<string>
  readonly legacyTimeoutSteps: number
  readonly sourceFamily: "python-formal" | "multistack" | "capability-eval" | "native-ts"
  readonly fixture: GoldenFixture
  readonly fixtureDigest: string
  readonly objective: string
  readonly allowedTools: ReadonlyArray<string>
  readonly policy: Readonly<Record<string, string | number | boolean>>
  readonly positiveAssertions: ReadonlyArray<Assertion>
  readonly negativeAssertions: ReadonlyArray<Assertion>
  readonly verifier: { readonly kind: "structured-assertions-and-checks"; readonly version: string }
  readonly budget: { readonly maxTokens: number; readonly maxCostMinor: number; readonly maxDurationMs: number }
  readonly supportedPlatforms: ReadonlyArray<string>
  readonly nondeterminism: "none" | "seeded" | "recorded-provider"
  readonly evidenceRetention: "result-only" | "full"
}

const pricingFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_pricing",
  language: "python",
  path: "app/pricing_1.py",
  content: `def compute_total(items, tax_rate=0.1, discount_threshold=90, discount_rate=0.05):
    # BUG: policies are ignored.
    return round(sum(items), 2)
`,
  tests: `import pytest
from app.pricing_1 import compute_total

def test_discount_then_tax():
    assert compute_total([90, 20], tax_rate=0.1, discount_threshold=90, discount_rate=0.05) == 114.95

def test_below_threshold_has_no_discount():
    assert compute_total([20, 30], tax_rate=0.1, discount_threshold=90) == 55.0
`,
})

const inventoryFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_inventory",
  language: "python",
  path: "app/inventory_1.py",
  content: `class Inventory:
    def __init__(self, stock):
        self.stock = dict(stock)
        self.audit = []

    def reserve(self, sku, qty):
        return self.stock.get(sku, 0) >= qty
`,
  tests: `import pytest
from app.inventory_1 import Inventory

def test_reserve_updates_stock_and_audit():
    inv = Inventory({"A": 11})
    assert inv.reserve("A", 3) is True
    assert inv.stock["A"] == 8
    assert inv.audit == [("A", 3)]

def test_insufficient_is_atomic():
    inv = Inventory({"A": 2})
    with pytest.raises(ValueError):
        inv.reserve("A", 3)
    assert inv.stock["A"] == 2 and inv.audit == []
`,
})

const slugFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_slug",
  language: "python",
  path: "app/slug_1.py",
  content: `def slugify(value, max_length=80):
    return value.lower().replace(" ", "-")
`,
  tests: `from app.slug_1 import slugify

def test_collapses_separators_and_keeps_unicode():
    assert slugify("  Arforge，中文  Agent!! ") == "arforge-中文-agent"

def test_respects_limit_without_trailing_dash():
    value = slugify("alpha beta gamma", max_length=21)
    assert len(value) <= 21 and not value.endswith("-")
`,
})

const retryFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_retry",
  language: "python",
  path: "app/retry_1.py",
  content: `def run_with_retry(operation, retries=2, retry_on=(RuntimeError,)):
    for _ in range(retries):
        try:
            return operation()
        except Exception:
            pass
    return None
`,
  tests: `import pytest
from app.retry_1 import run_with_retry

def test_succeeds_after_retry():
    calls = []
    def operation():
        calls.append(1)
        if len(calls) <= 3:
            raise RuntimeError("temporary")
        return "ok"
    assert run_with_retry(operation, retries=3) == "ok"
    assert len(calls) == 4
`,
})

const stateFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_state",
  language: "python",
  path: "app/state_1.py",
  content: `TRANSITIONS = {}

def transition(state, event):
    return event
`,
  tests: `import pytest
from app.state_1 import transition
from app.service_1 import OrderService

def test_happy_path():
    assert transition("draft", "submit") == "submitted"
    assert transition("submitted", "pay") == "paid"

def test_service_uses_transition():
    service = OrderService()
    assert service.apply("draft", "submit") == "submitted"
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "app/service_1.py",
      content: `from app.state_1 import transition

class OrderService:
    def apply(self, state, event):
        return transition(state, event)
`,
    },
  ]),
})

const refactorFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_refactor",
  language: "python",
  path: "app/legacy_1.py",
  content: `def normalize_name(value):
    return " ".join(value.strip().split()).title()

def process(record):
    return {**record, "name": normalize_name(record["name"])}
`,
  tests: `from app.legacy_1 import process, normalize_name

def test_process_normalizes_name():
    assert process({"name": "  ada   lovelace "})["name"] == "Ada Lovelace"

def test_legacy_export_remains():
    assert normalize_name("grace hopper") == "Grace Hopper"
`,
})

const architectureFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/formal_tasks.py::_architecture",
  language: "python",
  path: "app/api_1.py",
  content: `from app.store_1 import save_user

class User:
    def __init__(self, name):
        self.name = name

def create_user(name):
    user = User(name)
    save_user(user)
    return user
`,
  tests: `from app.api_1 import create_user

def test_create_user():
    assert create_user("Ada").name == "Ada"
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "app/store_1.py",
      content: `from app.api_1 import User

SAVED = []

def save_user(user: User):
    SAVED.append(user)
`,
    },
  ]),
})

const makePythonFormalCase = (input: {
  readonly family: string
  readonly index: number
  readonly category: string
  readonly fixture: GoldenFixture
  readonly objective: string
  readonly positiveAssertions: ReadonlyArray<Assertion>
  readonly negativeAssertions: ReadonlyArray<Assertion>
  readonly maxFilesChanged?: number
}): GoldenCase =>
  Object.freeze({
    suiteID: "python-formal",
    suiteRevision: 1,
    caseID: `formal-${input.family}-${String(input.index).padStart(2, "0")}`,
    caseRevision: 1,
    legacyTaskID: input.fixture.path.split("/").pop()!.replace(/\.py$/, ""),
    legacyCategory: input.category,
    legacyExpectedFiles: [input.fixture.path, "tests/test_regression.py"],
    legacyTimeoutSteps: 30,
    sourceFamily: "python-formal" as const,
    fixture: input.fixture,
    fixtureDigest: digest(input.fixture),
    objective: input.objective,
    allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
    policy: { network: "deny", shell: "fixture-only", maxFilesChanged: input.maxFilesChanged ?? 3 },
    positiveAssertions: input.positiveAssertions,
    negativeAssertions: input.negativeAssertions,
    verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
    budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
    supportedPlatforms: ["win32", "linux", "darwin"],
    nondeterminism: "none" as const,
    evidenceRetention: "result-only" as const,
  })

const makePricingCase = (index: number): GoldenCase => {
  const threshold = 80 + index * 10
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_pricing",
    language: "python",
    path: `app/pricing_${index}.py`,
    content: `def compute_total(items, tax_rate=0.1, discount_threshold=${threshold}, discount_rate=0.05):
    # BUG: policies are ignored.
    return round(sum(items), 2)
`,
    tests: `import pytest
from app.pricing_${index} import compute_total

def test_discount_then_tax():
    assert compute_total([${threshold}, 20], tax_rate=0.1, discount_threshold=${threshold}, discount_rate=0.05) == ${Math.round((threshold + 20) * 0.95 * 1.1 * 100) / 100}

def test_below_threshold_has_no_discount():
    assert compute_total([20, 30], tax_rate=0.1, discount_threshold=${threshold}) == 55.0
`,
  })
  return makePythonFormalCase({
    family: "pricing",
    index,
    category: "bug_fix",
    fixture,
    objective: `修复 app/pricing_${index}.py 的订单计价。小计达到 ${threshold} 时先应用折扣，再计算税费，结果保留两位小数；拒绝负数条目。保持现有 API，新增 tests/test_regression.py 覆盖阈值边界和负数，并运行全部 pytest。`,
    positiveAssertions: [
      { id: "discount_then_tax", kind: "equals", actualKey: "discountThenTax", expected: Math.round((threshold + 20) * 0.95 * 1.1 * 100) / 100 },
      { id: "below_threshold", kind: "equals", actualKey: "belowThreshold", expected: 55 },
    ],
    negativeAssertions: [{ id: "negative_rejected", kind: "equals", actualKey: "negativeRejected", expected: true }],
  })
}

const makeInventoryCase = (index: number): GoldenCase => {
  const initial = 10 + index
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_inventory",
    language: "python",
    path: `app/inventory_${index}.py`,
    content: `class Inventory:
    def __init__(self, stock):
        self.stock = dict(stock)
        self.audit = []

    def reserve(self, sku, qty):
        return self.stock.get(sku, 0) >= qty
`,
    tests: `import pytest
from app.inventory_${index} import Inventory

def test_reserve_updates_stock_and_audit():
    inv = Inventory({"A": ${initial}})
    assert inv.reserve("A", 3) is True
    assert inv.stock["A"] == ${initial - 3}
    assert inv.audit == [("A", 3)]

def test_insufficient_is_atomic():
    inv = Inventory({"A": 2})
    with pytest.raises(ValueError):
        inv.reserve("A", 3)
    assert inv.stock["A"] == 2 and inv.audit == []
`,
  })
  return makePythonFormalCase({
    family: "inventory",
    index,
    category: "feature_add",
    fixture,
    objective: `完善 app/inventory_${index}.py 的 Inventory.reserve：数量必须为正且不能超过库存，成功时扣减库存并记录 (sku, qty) 到 audit。异常使用 ValueError。新增 tests/test_regression.py 覆盖原子失败和连续预留，运行全部 pytest。`,
    positiveAssertions: [
      { id: "reserve_valid", kind: "equals", actualKey: "reserveValid", expected: true },
      { id: "audit_recorded", kind: "equals", actualKey: "auditRecorded", expected: true },
    ],
    negativeAssertions: [{ id: "insufficient_is_atomic", kind: "equals", actualKey: "insufficientAtomic", expected: true }],
  })
}

const makeSlugCase = (index: number): GoldenCase => {
  const limit = 20 + index
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_slug",
    language: "python",
    path: `app/slug_${index}.py`,
    content: `def slugify(value, max_length=80):
    return value.lower().replace(" ", "-")
`,
    tests: `from app.slug_${index} import slugify

def test_collapses_separators_and_keeps_unicode():
    assert slugify("  Arforge，中文  Agent!! ") == "arforge-中文-agent"

def test_respects_limit_without_trailing_dash():
    value = slugify("alpha beta gamma", max_length=${limit})
    assert len(value) <= ${limit} and not value.endswith("-")
`,
  })
  return makePythonFormalCase({
    family: "slug",
    index,
    category: "data_processing",
    fixture,
    objective: `实现 app/slug_${index}.py 的 slugify(value, max_length=${limit})：Unicode 字母数字保留并转小写，连续空白或标点折叠为一个连字符，去掉首尾连字符，按 max_length 截断后再次清理尾部。新增 tests/test_regression.py 覆盖中文、连续标点和截断，运行全部 pytest。`,
    positiveAssertions: [
      { id: "unicode_slug", kind: "equals", actualKey: "unicodeSlug", expected: "arforge-中文-agent" },
      { id: "bounded_without_dash", kind: "equals", actualKey: "boundedWithoutDash", expected: true },
    ],
    negativeAssertions: [{ id: "no_empty_slug", kind: "equals", actualKey: "emptySlug", expected: false }],
  })
}

const makeRetryCase = (index: number): GoldenCase => {
  const retries = 2 + (index % 3)
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_retry",
    language: "python",
    path: `app/retry_${index}.py`,
    content: `def run_with_retry(operation, retries=2, retry_on=(RuntimeError,)):
    for _ in range(retries):
        try:
            return operation()
        except Exception:
            pass
    return None
`,
    tests: `import pytest
from app.retry_${index} import run_with_retry

def test_succeeds_after_retry():
    calls = []
    def operation():
        calls.append(1)
        if len(calls) <= ${retries}:
            raise RuntimeError("temporary")
        return "ok"
    assert run_with_retry(operation, retries=${retries}) == "ok"
    assert len(calls) == ${retries + 1}
`,
  })
  return makePythonFormalCase({
    family: "retry",
    index,
    category: "test_write",
    fixture,
    objective: `修复 app/retry_${index}.py 的 run_with_retry。retries=${retries} 表示首次调用之外最多再试该次数；只重试 retry_on 指定异常，成功立即返回，耗尽后重抛最后异常。新增 tests/test_regression.py 覆盖非重试异常与精确调用次数，运行全部 pytest。`,
    positiveAssertions: [
      { id: "retry_returns_value", kind: "equals", actualKey: "retryReturnsValue", expected: true },
      { id: "exact_call_count", kind: "equals", actualKey: "exactCallCount", expected: retries + 1 },
    ],
    negativeAssertions: [{ id: "non_retry_exception_propagates", kind: "equals", actualKey: "nonRetryExceptionPropagates", expected: true }],
  })
}

const makeStateCase = (index: number): GoldenCase => {
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_state",
    language: "python",
    path: `app/state_${index}.py`,
    content: `TRANSITIONS = {}

def transition(state, event):
    return event
`,
    tests: `import pytest
from app.state_${index} import transition
from app.service_${index} import OrderService

def test_happy_path():
    assert transition("draft", "submit") == "submitted"
    assert transition("submitted", "pay") == "paid"

def test_service_uses_transition():
    service = OrderService()
    assert service.apply("draft", "submit") == "submitted"
`,
    supportingFiles: freezeFixtureFiles([
      {
        path: `app/service_${index}.py`,
        content: `from app.state_${index} import transition

class OrderService:
    def apply(self, state, event):
        return transition(state, event)
`,
      },
    ]),
  })
  return makePythonFormalCase({
    family: "state",
    index,
    category: "multi_file",
    fixture,
    objective: `修复 app/state_${index}.py 的订单状态机，并让 app/service_${index}.py 继续使用它。合法转换为 draft+submit→submitted、submitted+pay→paid、submitted+cancel→cancelled；其他组合抛 ValueError。新增 tests/test_regression.py 覆盖终态和服务层，运行全部 pytest。`,
    maxFilesChanged: 4,
    positiveAssertions: [
      { id: "happy_path", kind: "equals", actualKey: "happyPath", expected: true },
      { id: "service_uses_transition", kind: "equals", actualKey: "serviceUsesTransition", expected: true },
    ],
    negativeAssertions: [{ id: "invalid_transition_rejected", kind: "equals", actualKey: "invalidRejected", expected: true }],
  })
}

const makeRefactorCase = (index: number): GoldenCase => {
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_refactor",
    language: "python",
    path: `app/legacy_${index}.py`,
    content: `def normalize_name(value):
    return " ".join(value.strip().split()).title()

def process(record):
    return {**record, "name": normalize_name(record["name"])}
`,
    tests: `from app.legacy_${index} import process, normalize_name

def test_process_normalizes_name():
    assert process({"name": "  ada   lovelace "})["name"] == "Ada Lovelace"

def test_legacy_export_remains():
    assert normalize_name("grace hopper") == "Grace Hopper"
`,
  })
  return makePythonFormalCase({
    family: "refactor",
    index,
    category: "refactor",
    fixture,
    objective: `重构 app/legacy_${index}.py：把 normalize_name 移到新的 app/text_${index}.py，legacy 模块保留兼容导入，process 的外部行为不能改变。新增 tests/test_regression.py 覆盖兼容入口、空白折叠和 Unicode 名称，运行全部 pytest。`,
    maxFilesChanged: 4,
    positiveAssertions: [
      { id: "compatibility_entry", kind: "equals", actualKey: "compatibilityEntry", expected: true },
      { id: "normalized_name", kind: "equals", actualKey: "normalizedName", expected: "Ada Lovelace" },
    ],
    negativeAssertions: [{ id: "legacy_behavior_changed", kind: "equals", actualKey: "legacyBehaviorChanged", expected: false }],
  })
}

const makeArchitectureCase = (index: number): GoldenCase => {
  const fixture: GoldenFixture = Object.freeze({
    source: "arforge/eval/formal_tasks.py::_architecture",
    language: "python",
    path: `app/api_${index}.py`,
    content: `from app.store_${index} import save_user

class User:
    def __init__(self, name):
        self.name = name

def create_user(name):
    user = User(name)
    save_user(user)
    return user
`,
    tests: `from app.api_${index} import create_user

def test_create_user():
    assert create_user("Ada").name == "Ada"
`,
    supportingFiles: freezeFixtureFiles([
      {
        path: `app/store_${index}.py`,
        content: `from app.api_${index} import User

SAVED = []

def save_user(user: User):
    SAVED.append(user)
`,
      },
    ]),
  })
  return makePythonFormalCase({
    family: "architecture",
    index,
    category: "architecture_qa",
    fixture,
    objective: `修复 app/api_${index}.py 与 app/store_${index}.py 的循环依赖，把共享 User 模型移到 app/models_${index}.py，保持 create_user 和 save_user API。新增 ARCHITECTURE.md 说明依赖方向，并新增 tests/test_regression.py 验证模块可独立导入，运行全部 pytest。`,
    maxFilesChanged: 5,
    positiveAssertions: [
      { id: "create_user_api", kind: "equals", actualKey: "createUserApi", expected: true },
      { id: "architecture_documented", kind: "equals", actualKey: "architectureDocumented", expected: true },
    ],
    negativeAssertions: [{ id: "circular_import", kind: "equals", actualKey: "circularImport", expected: false }],
  })
}

const generatedPythonFormalCases: ReadonlyArray<GoldenCase> = [
  ...Array.from({ length: 7 }, (_, index) => makePricingCase(index + 2)),
  ...Array.from({ length: 6 }, (_, index) => makeInventoryCase(index + 2)),
  ...Array.from({ length: 6 }, (_, index) => makeSlugCase(index + 2)),
  ...Array.from({ length: 6 }, (_, index) => makeRetryCase(index + 2)),
  ...Array.from({ length: 6 }, (_, index) => makeStateCase(index + 2)),
  ...Array.from({ length: 6 }, (_, index) => makeRefactorCase(index + 2)),
  ...Array.from({ length: 6 }, (_, index) => makeArchitectureCase(index + 2)),
]

const capabilityEvalDefinitions = [
  ["g6-resume-artifacts", "resume"],
  ["g11-impacted-tests", "regression"],
  ["g13-interrupt-control-file", "interrupt"],
  ["g19-danger-guard", "security"],
  ["g20-replay-report", "replay"],
  ["ma1-hard-timeout", "multiagent"],
  ["ma2-progress-cancel", "multiagent"],
  ["ma3-role-boundaries", "multiagent"],
  ["ma4-unified-worker-runtime", "multiagent"],
  ["pr1-thinking-tool-choice", "provider"],
  ["rd1-package-version", "readiness"],
  ["ci1-quality-workflow", "automation"],
  ["ob1-telemetry-isolation", "observability"],
  ["sc0-created-test-order", "self_correct"],
  ["sc1-failure-feedback", "self_correct"],
  ["sc2-repeat-call-block", "self_correct"],
  ["sc3-syntax-reflection", "self_correct"],
  ["sc4-tool-message-order", "self_correct"],
  ["sc5-unexecuted-tool-text-block", "self_correct"],
  ["sc6-cleanup-tool-switch", "self_correct"],
  ["sc7-verification-gate", "self_correct"],
  ["sc8-post-edit-consistency", "self_correct"],
  ["sc9-test-fix-loop", "self_correct"],
  ["sc10-cross-file-imports", "self_correct"],
  ["sc11-transient-retry", "self_correct"],
  ["sc12-auto-test-loop", "self_correct"],
] as const

const makeCapabilityEvalCase = (id: string, category: string): GoldenCase => {
  const fixture: GoldenFixture = Object.freeze({
    source: `arforge/core/capability_eval.py::${id}`,
    language: "python",
    path: "arforge/core/capability_eval.py",
    content: `CapabilityEvalTask id=${id} category=${category}\n`,
    tests: `run_capability_eval task=${id}; assert success=true; assert model_invoked=false\n`,
  })
  return Object.freeze({
    suiteID: "capability-eval",
    suiteRevision: 1,
    caseID: id,
    caseRevision: 1,
    legacyTaskID: id,
    legacyCategory: category,
    legacyExpectedFiles: ["capability-eval-report.json"],
    legacyTimeoutSteps: 1,
    sourceFamily: "capability-eval",
    fixture,
    fixtureDigest: digest(fixture),
    objective: `验证 capability-eval ${id} (${category})：执行本地确定性基础设施合同，必须通过且不调用模型。`,
    allowedTools: ["process.run"],
    policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 0 },
    positiveAssertions: [{ id: "task_passed", kind: "equals" as const, actualKey: "passed", expected: true }],
    negativeAssertions: [{ id: "model_invoked", kind: "equals" as const, actualKey: "modelInvoked", expected: false }],
    verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
    budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 1_000 },
    supportedPlatforms: ["win32", "linux", "darwin"],
    nondeterminism: "none",
    evidenceRetention: "result-only",
  })
}

const generatedCapabilityEvalCases: ReadonlyArray<GoldenCase> = capabilityEvalDefinitions.map(([id, category]) =>
  makeCapabilityEvalCase(id, category),
)

const multistackSqlFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_sql(51,101)",
  language: "sql",
  path: "src/schema.sql",
  content: `CREATE TABLE score_policy (
  id INTEGER PRIMARY KEY,
  threshold INTEGER NOT NULL DEFAULT 51,
  maximum INTEGER NOT NULL DEFAULT 101,
  CHECK (threshold >= 0),
  CHECK (maximum >= threshold)
);
-- BUG: the required upper bound for maximum is missing.
`,
  tests: `INSERT INTO score_policy(id, threshold, maximum) VALUES (1, 51, 101);
SELECT threshold, maximum FROM score_policy WHERE id = 1;
`,
})

const multistackJavascriptFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_javascript(51,101)",
  language: "javascript",
  path: "src/policy.js",
  content: `export function classify(value, threshold, maximum) {
  // BUG: ignores range validation and the supplied threshold.
  return value >= 60 ? "pass" : "fail";
}
`,
  tests: `import test from "node:test";
import assert from "node:assert/strict";
import { evaluateScore } from "../src/service.js";
test("public service honours the configured threshold", () => {
  assert.equal(evaluateScore(51, 51, 101), "pass");
  assert.equal(evaluateScore(50, 51, 101), "fail");
});
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "package.json",
      content: `{"name":"arforge-formal-js","private":true,"type":"module","scripts":{"test":"node --test tests/*.test.js"}}
`,
    },
    {
      path: "src/service.js",
      content: `import { classify } from "./policy.js";
export const evaluateScore = (value, threshold, maximum) =>
  classify(value, threshold, maximum);
`,
    },
  ]),
})

const multistackJavaFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_java(51,101)",
  language: "java",
  path: "src/Policy.java",
  content: `public final class Policy {
    public static String classify(int value, int threshold, int maximum) {
        // BUG: ignores range validation and the supplied threshold.
        return value >= 60 ? "pass" : "fail";
    }
}
`,
  tests: `public final class ContractTest {
    public static void main(String[] args) {
        ScoreService service = new ScoreService();
        if (!"pass".equals(service.evaluate(51, 51, 101))) throw new AssertionError();
        if (!"fail".equals(service.evaluate(50, 51, 101))) throw new AssertionError();
    }
}
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "src/ScoreService.java",
      content: `public final class ScoreService {
    public String evaluate(int value, int threshold, int maximum) {
        return Policy.classify(value, threshold, maximum);
    }
}
`,
    },
  ]),
})

const multistackRustFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_rust(51,101)",
  language: "rust",
  path: "src/lib.rs",
  content: `pub fn classify(value: i32, threshold: i32, maximum: i32) -> &'static str {
    // BUG: ignores range validation and the supplied threshold.
    if value >= 60 { "pass" } else { "fail" }
}

pub fn evaluate_score(value: i32, threshold: i32, maximum: i32) -> &'static str {
    classify(value, threshold, maximum)
}
`,
  tests: `use arforge_formal_rust::evaluate_score;
#[test]
fn configured_threshold() {
    assert_eq!(evaluate_score(51, 51, 101), "pass");
    assert_eq!(evaluate_score(50, 51, 101), "fail");
}
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "Cargo.toml",
      content: `[package]
name="arforge-formal-rust"
version="0.1.0"
edition="2021"
`,
    },
  ]),
})

const multistackCFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_c(51,101)",
  language: "c",
  path: "src/policy.c",
  content: `#include "policy.h"
const char *classify_score(int value, int threshold, int maximum) {
    /* BUG: ignores range validation and the supplied threshold. */
    return value >= 60 ? "pass" : "fail";
}
const char *evaluate_score(int value, int threshold, int maximum) {
    return classify_score(value, threshold, maximum);
}
`,
  tests: `#include <assert.h>
#include <string.h>
#include "policy.h"
int main(void) {
    assert(strcmp(evaluate_score(51, 51, 101), "pass") == 0);
    assert(strcmp(evaluate_score(50, 51, 101), "fail") == 0);
    return 0;
}
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "include/policy.h",
      content: `#ifndef POLICY_H
#define POLICY_H
const char *classify_score(int value, int threshold, int maximum);
const char *evaluate_score(int value, int threshold, int maximum);
#endif
`,
    },
  ]),
})

const multistackCppFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_cpp(51,101)",
  language: "cpp",
  path: "src/policy.cpp",
  content: `#include "policy.hpp"
std::string classify_score(int value, int threshold, int maximum) {
    // BUG: ignores range validation and the supplied threshold.
    return value >= 60 ? "pass" : "fail";
}
std::string evaluate_score(int value, int threshold, int maximum) {
    return classify_score(value, threshold, maximum);
}
`,
  tests: `#include <cassert>
#include "policy.hpp"
int main() {
    assert(evaluate_score(51, 51, 101) == "pass");
    assert(evaluate_score(50, 51, 101) == "fail");
}
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "include/policy.hpp",
      content: `#pragma once
#include <string>
std::string classify_score(int value, int threshold, int maximum);
std::string evaluate_score(int value, int threshold, int maximum);
`,
    },
  ]),
})

const multistackCsharpFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_csharp(51,101)",
  language: "csharp",
  path: "Policy.cs",
  content: `public static class Policy {
    public static string Classify(int value, int threshold, int maximum) {
        // BUG: ignores range validation and the supplied threshold.
        return value >= 60 ? "pass" : "fail";
    }
}
public sealed class ScoreService {
    public string Evaluate(int value, int threshold, int maximum) =>
        Policy.Classify(value, threshold, maximum);
}
`,
  tests: `var service = new ScoreService();
if (service.Evaluate(51, 51, 101) != "pass") throw new Exception("threshold");
if (service.Evaluate(50, 51, 101) != "fail") throw new Exception("below");
var regression = Type.GetType("RegressionChecks") ?? throw new Exception("RegressionChecks missing");
regression.GetMethod("Run")?.Invoke(null, null);
Console.WriteLine("PASS");
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "Acceptance.csproj",
      content: `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>
`,
    },
  ]),
})

const multistackGoFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_go(51,101)",
  language: "go",
  path: "policy/policy.go",
  content: `package policy

func Classify(value, threshold, maximum int) string {
	// BUG: ignores range validation and the supplied threshold.
	if value >= 60 {
		return "pass"
	}
	return "fail"
}
`,
  tests: `package service

import "testing"

func TestConfiguredThreshold(t *testing.T) {
	if EvaluateScore(51, 51, 101) != "pass" { t.Fatal("threshold") }
	if EvaluateScore(50, 51, 101) != "fail" { t.Fatal("below") }
}
`,
  supportingFiles: freezeFixtureFiles([
    {
      path: "go.mod",
      content: `module example.com/arforge/formal

go 1.23
`,
    },
    {
      path: "service/service.go",
      content: `package service

import "example.com/arforge/formal/policy"

func EvaluateScore(value, threshold, maximum int) string {
	return policy.Classify(value, threshold, maximum)
}
`,
    },
  ]),
})

const multistackPhpFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_php(51,101)",
  language: "php",
  path: "src/Policy.php",
  content: `<?php
function classify_score(int $value, int $threshold, int $maximum): string {
    // BUG: ignores range validation and the supplied threshold.
    return $value >= 60 ? "pass" : "fail";
}
function evaluate_score(int $value, int $threshold, int $maximum): string {
    return classify_score($value, $threshold, $maximum);
}
`,
  tests: `<?php
require __DIR__ . "/../src/Policy.php";
assert(evaluate_score(51, 51, 101) === "pass");
assert(evaluate_score(50, 51, 101) === "fail");
`,
})

const multistackRubyFixture: GoldenFixture = Object.freeze({
  source: "arforge/eval/multistack_formal_tasks.py::_setup_ruby(51,101)",
  language: "ruby",
  path: "lib/policy.rb",
  content: `def classify_score(value, threshold, maximum)
  # BUG: ignores range validation and the supplied threshold.
  value >= 60 ? "pass" : "fail"
end

def evaluate_score(value, threshold, maximum)
  classify_score(value, threshold, maximum)
end
`,
  tests: `require "minitest/autorun"
require_relative "../lib/policy"
class ContractTest < Minitest::Test
  def test_configured_threshold
    assert_equal "pass", evaluate_score(51, 51, 101)
    assert_equal "fail", evaluate_score(50, 51, 101)
  end
end
`,
})

const pricingCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-pricing-01",
  caseRevision: 1,
  legacyTaskID: "pricing_1",
  legacyCategory: "bug_fix",
  legacyExpectedFiles: ["app/pricing_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: pricingFixture,
  fixtureDigest: digest(pricingFixture),
  objective:
    "修复 app/pricing_1.py 的订单计价。小计达到 90 时先应用折扣，再计算税费，结果保留两位小数；拒绝负数条目。保持现有 API，新增 tests/test_regression.py 覆盖阈值边界和负数，并运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 3 },
  positiveAssertions: [
    { id: "discount_then_tax", kind: "equals" as const, actualKey: "discountThenTax", expected: 114.95 },
    { id: "below_threshold", kind: "equals" as const, actualKey: "belowThreshold", expected: 55 },
  ],
  negativeAssertions: [{ id: "negative_rejected", kind: "equals" as const, actualKey: "negativeRejected", expected: true }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const inventoryCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-inventory-01",
  caseRevision: 1,
  legacyTaskID: "inventory_1",
  legacyCategory: "feature_add",
  legacyExpectedFiles: ["app/inventory_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: inventoryFixture,
  fixtureDigest: digest(inventoryFixture),
  objective:
    "完善 app/inventory_1.py 的 Inventory.reserve：数量必须为正且不能超过库存，成功时扣减库存并记录 (sku, qty) 到 audit。异常使用 ValueError。新增 tests/test_regression.py 覆盖原子失败和连续预留，运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 3 },
  positiveAssertions: [
    { id: "reserve_valid", kind: "equals" as const, actualKey: "reserveValid", expected: true },
    { id: "audit_recorded", kind: "equals" as const, actualKey: "auditRecorded", expected: true },
  ],
  negativeAssertions: [{ id: "insufficient_is_atomic", kind: "equals" as const, actualKey: "insufficientAtomic", expected: true }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const slugCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-slug-01",
  caseRevision: 1,
  legacyTaskID: "slug_1",
  legacyCategory: "data_processing",
  legacyExpectedFiles: ["app/slug_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: slugFixture,
  fixtureDigest: digest(slugFixture),
  objective:
    "实现 app/slug_1.py 的 slugify(value, max_length=21)：Unicode 字母数字保留并转小写，连续空白或标点折叠为一个连字符，去掉首尾连字符，按 max_length 截断后再次清理尾部。新增 tests/test_regression.py 覆盖中文、连续标点和截断，运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 3 },
  positiveAssertions: [
    { id: "unicode_slug", kind: "equals" as const, actualKey: "unicodeSlug", expected: "arforge-中文-agent" },
    { id: "bounded_without_dash", kind: "equals" as const, actualKey: "boundedWithoutDash", expected: true },
  ],
  negativeAssertions: [{ id: "no_empty_slug", kind: "equals" as const, actualKey: "emptySlug", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const retryCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-retry-01",
  caseRevision: 1,
  legacyTaskID: "retry_1",
  legacyCategory: "test_write",
  legacyExpectedFiles: ["app/retry_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: retryFixture,
  fixtureDigest: digest(retryFixture),
  objective:
    "修复 app/retry_1.py 的 run_with_retry。retries=3 表示首次调用之外最多再试该次数；只重试 retry_on 指定异常，成功立即返回，耗尽后重抛最后异常。新增 tests/test_regression.py 覆盖非重试异常与精确调用次数，运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 3 },
  positiveAssertions: [
    { id: "retry_returns_value", kind: "equals" as const, actualKey: "retryReturnsValue", expected: true },
    { id: "exact_call_count", kind: "equals" as const, actualKey: "exactCallCount", expected: 4 },
  ],
  negativeAssertions: [
    { id: "non_retry_exception_propagates", kind: "equals" as const, actualKey: "nonRetryExceptionPropagates", expected: true },
  ],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const stateCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-state-01",
  caseRevision: 1,
  legacyTaskID: "state_1",
  legacyCategory: "multi_file",
  legacyExpectedFiles: ["app/state_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: stateFixture,
  fixtureDigest: digest(stateFixture),
  objective:
    "修复 app/state_1.py 的订单状态机，并让 app/service_1.py 继续使用它。合法转换为 draft+submit→submitted、submitted+pay→paid、submitted+cancel→cancelled；其他组合抛 ValueError。新增 tests/test_regression.py 覆盖终态和服务层，运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 4 },
  positiveAssertions: [
    { id: "happy_path", kind: "equals" as const, actualKey: "happyPath", expected: true },
    { id: "service_uses_transition", kind: "equals" as const, actualKey: "serviceUsesTransition", expected: true },
  ],
  negativeAssertions: [{ id: "invalid_transition_rejected", kind: "equals" as const, actualKey: "invalidRejected", expected: true }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const refactorCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-refactor-01",
  caseRevision: 1,
  legacyTaskID: "legacy_1",
  legacyCategory: "refactor",
  legacyExpectedFiles: ["app/legacy_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: refactorFixture,
  fixtureDigest: digest(refactorFixture),
  objective:
    "重构 app/legacy_1.py：把 normalize_name 移到新的 app/text_1.py，legacy 模块保留兼容导入，process 的外部行为不能改变。新增 tests/test_regression.py 覆盖兼容入口、空白折叠和 Unicode 名称，运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 4 },
  positiveAssertions: [
    { id: "compatibility_entry", kind: "equals" as const, actualKey: "compatibilityEntry", expected: true },
    { id: "normalized_name", kind: "equals" as const, actualKey: "normalizedName", expected: "Ada Lovelace" },
  ],
  negativeAssertions: [{ id: "legacy_behavior_changed", kind: "equals" as const, actualKey: "legacyBehaviorChanged", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const architectureCase: GoldenCase = Object.freeze({
  suiteID: "python-formal",
  suiteRevision: 1,
  caseID: "formal-architecture-01",
  caseRevision: 1,
  legacyTaskID: "api_1",
  legacyCategory: "architecture_qa",
  legacyExpectedFiles: ["app/api_1.py", "tests/test_regression.py"],
  legacyTimeoutSteps: 30,
  sourceFamily: "python-formal",
  fixture: architectureFixture,
  fixtureDigest: digest(architectureFixture),
  objective:
    "修复 app/api_1.py 与 app/store_1.py 的循环依赖，把共享 User 模型移到 app/models_1.py，保持 create_user 和 save_user API。新增 ARCHITECTURE.md 说明依赖方向，并新增 tests/test_regression.py 验证模块可独立导入，运行全部 pytest。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "create_user_api", kind: "equals" as const, actualKey: "createUserApi", expected: true },
    { id: "architecture_documented", kind: "equals" as const, actualKey: "architectureDocumented", expected: true },
  ],
  negativeAssertions: [{ id: "circular_import", kind: "equals" as const, actualKey: "circularImport", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 30_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackSqlCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-sql-01",
  caseRevision: 1,
  legacyTaskID: "multistack-sql-01",
  legacyCategory: "cross_language_sql",
  legacyExpectedFiles: ["tests/regression.sql"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackSqlFixture,
  fixtureDigest: digest(multistackSqlFixture),
  objective:
    "修复这个 SQL/SQLite 项目的 score_policy 数据完整性规则。threshold 必须大于等于 0，maximum 必须大于等于 threshold 且不能超过 1000。保持现有表名、列名和默认值，使用数据库自身约束拒绝非法数据，不能依赖应用层过滤。新增 tests/regression.sql，写入多个合法边界样例并查询验证。最后用 SQLite 在全新内存数据库中依次执行 schema、contract 和 regression。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 3 },
  positiveAssertions: [
    { id: "constraints_enforced", kind: "equals" as const, actualKey: "constraintsEnforced", expected: true },
    { id: "regression_passed", kind: "equals" as const, actualKey: "regressionPassed", expected: true },
  ],
  negativeAssertions: [{ id: "application_filter_not_used", kind: "equals" as const, actualKey: "databaseConstraint", expected: true }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackJavascriptCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-javascript-01",
  caseRevision: 1,
  legacyTaskID: "multistack-javascript-01",
  legacyCategory: "cross_language_javascript",
  legacyExpectedFiles: ["tests/regression.test.js"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackJavascriptFixture,
  fixtureDigest: digest(multistackJavascriptFixture),
  objective:
    "修复这个 JavaScript/Node.js 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/regression.test.js，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `npm test`，确认原有契约测试和新增回归测试全部通过。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackJavaCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-java-01",
  caseRevision: 1,
  legacyTaskID: "multistack-java-01",
  legacyCategory: "cross_language_java",
  legacyExpectedFiles: ["tests/RegressionTest.java"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackJavaFixture,
  fixtureDigest: digest(multistackJavaFixture),
  objective:
    "修复这个 Java 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/RegressionTest.java，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `javac + java ContractTest/RegressionTest`，确认原有契约测试和新增回归测试全部通过。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackRustCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-rust-01",
  caseRevision: 1,
  legacyTaskID: "multistack-rust-01",
  legacyCategory: "cross_language_rust",
  legacyExpectedFiles: ["tests/regression.rs"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackRustFixture,
  fixtureDigest: digest(multistackRustFixture),
  objective:
    "修复这个 Rust 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/regression.rs，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `cargo test`，确认原有契约测试和新增回归测试全部通过。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackCCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-c-01",
  caseRevision: 1,
  legacyTaskID: "multistack-c-01",
  legacyCategory: "cross_language_c",
  legacyExpectedFiles: ["tests/regression.c"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackCFixture,
  fixtureDigest: digest(multistackCFixture),
  objective:
    "修复这个 C 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/regression.c，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `gcc 编译并运行 contract/regression`，确认原有契约测试和新增回归测试全部通过。run_cmd 不支持 && 串联命令，请分别编译、分别运行；在 Windows PowerShell 上执行编译产物必须使用明确相对路径 `.\\contract.exe` 和 `.\\regression.exe`（不能只写文件名，也不要用 `./`）。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackCppCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-cpp-01",
  caseRevision: 1,
  legacyTaskID: "multistack-cpp-01",
  legacyCategory: "cross_language_cpp",
  legacyExpectedFiles: ["tests/regression.cpp"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackCppFixture,
  fixtureDigest: digest(multistackCppFixture),
  objective:
    "修复这个 C++ 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/regression.cpp，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `g++ 编译并运行 contract/regression`，确认原有契约测试和新增回归测试全部通过。run_cmd 不支持 && 串联命令，请分别编译、分别运行；在 Windows PowerShell 上执行编译产物必须使用明确相对路径 `.\\contract.exe` 和 `.\\regression.exe`（不能只写文件名，也不要用 `./`）。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackCsharpCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-csharp-01",
  caseRevision: 1,
  legacyTaskID: "multistack-csharp-01",
  legacyCategory: "cross_language_csharp",
  legacyExpectedFiles: ["RegressionChecks.cs"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackCsharpFixture,
  fixtureDigest: digest(multistackCsharpFixture),
  objective:
    "修复这个 C#/.NET 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 RegressionChecks.cs，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `dotnet run --project Acceptance.csproj`，确认原有契约测试和新增回归测试全部通过。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackGoCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-go-01",
  caseRevision: 1,
  legacyTaskID: "multistack-go-01",
  legacyCategory: "cross_language_go",
  legacyExpectedFiles: ["service/regression_test.go"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackGoFixture,
  fixtureDigest: digest(multistackGoFixture),
  objective:
    "修复这个 Go 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 service/regression_test.go，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `go test ./...`，确认原有契约测试和新增回归测试全部通过。如果本机没有 go，不要安装或搜索系统目录，直接调用 run_tests 并指定 framework=go；该工具会使用固定 Go 容器验证。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackPhpCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-php-01",
  caseRevision: 1,
  legacyTaskID: "multistack-php-01",
  legacyCategory: "cross_language_php",
  legacyExpectedFiles: ["tests/regression.php"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackPhpFixture,
  fixtureDigest: digest(multistackPhpFixture),
  objective:
    "修复这个 PHP 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/regression.php，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `php tests/contract.php && php tests/regression.php`，确认原有契约测试和新增回归测试全部通过。如果本机没有 php，直接调用 run_tests 并指定 framework=php；该工具会在固定 PHP 容器中依次运行所有测试文件。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackRubyCase: GoldenCase = Object.freeze({
  suiteID: "multistack-formal",
  suiteRevision: 1,
  caseID: "multistack-ruby-01",
  caseRevision: 1,
  legacyTaskID: "multistack-ruby-01",
  legacyCategory: "cross_language_ruby",
  legacyExpectedFiles: ["tests/regression_test.rb"],
  legacyTimeoutSteps: 40,
  sourceFamily: "multistack",
  fixture: multistackRubyFixture,
  fixtureDigest: digest(multistackRubyFixture),
  objective:
    "修复这个 Ruby 项目的分数策略。classify(value, threshold, maximum) 必须在 value 小于 0 或大于 maximum 时返回 \"invalid\"，在 value 大于等于 threshold 时返回 \"pass\"，其余返回 \"fail\"。保持现有 Service/服务层 API 和项目结构，不要绕过策略层。当前任务的主要阈值是 51，但实现不能把它写死。新增 tests/regression_test.rb，覆盖负数、超过 maximum、阈值边界和自定义阈值。最后运行 `运行 tests/*_test.rb`，确认原有契约测试和新增回归测试全部通过。如果本机没有 ruby，不要尝试安装或搜索系统目录，直接调用 run_tests 并指定 framework=ruby；该工具会使用固定的安全容器回退。",
  allowedTools: ["filesystem.read", "filesystem.write", "process.run"],
  policy: { network: "deny", shell: "fixture-only", maxFilesChanged: 5 },
  positiveAssertions: [
    { id: "threshold_pass", kind: "equals" as const, actualKey: "thresholdPass", expected: true },
    { id: "custom_threshold", kind: "equals" as const, actualKey: "customThreshold", expected: true },
    { id: "invalid_range", kind: "equals" as const, actualKey: "invalidRange", expected: true },
  ],
  negativeAssertions: [{ id: "service_bypasses_policy", kind: "equals" as const, actualKey: "serviceBypassesPolicy", expected: false }],
  verifier: { kind: "structured-assertions-and-checks" as const, version: "v1" },
  budget: { maxTokens: 0, maxCostMinor: 0, maxDurationMs: 40_000 },
  supportedPlatforms: ["win32", "linux", "darwin"],
  nondeterminism: "none",
  evidenceRetention: "result-only",
})

const multistackSeedCases: ReadonlyArray<GoldenCase> = [
  multistackJavascriptCase,
  multistackJavaCase,
  multistackRustCase,
  multistackCCase,
  multistackCppCase,
  multistackCsharpCase,
  multistackGoCase,
  multistackPhpCase,
  multistackRubyCase,
  multistackSqlCase,
]

const replaceMultistackVariantText = (value: string, threshold: number, maximum: number): string =>
  value
    .replaceAll("51", String(threshold))
    .replaceAll("101", String(maximum))
    .replaceAll("50", String(threshold - 1))

const makeMultistackVariant = (seed: GoldenCase, index: number): GoldenCase => {
  const threshold = 48 + index * 3
  const maximum = 100 + index
  const stackID = seed.caseID.replace(/^multistack-/, "").replace(/-01$/, "")
  const caseID = `multistack-${stackID}-${String(index).padStart(2, "0")}`
  const fixture = Object.freeze({
    ...seed.fixture,
    source: replaceMultistackVariantText(seed.fixture.source, threshold, maximum),
    content: replaceMultistackVariantText(seed.fixture.content, threshold, maximum),
    tests: replaceMultistackVariantText(seed.fixture.tests, threshold, maximum),
    ...(seed.fixture.supportingFiles === undefined
      ? {}
      : {
          supportingFiles: freezeFixtureFiles(
            seed.fixture.supportingFiles.map((file) => ({
              path: file.path,
              content: replaceMultistackVariantText(file.content, threshold, maximum),
            })),
          ),
        }),
  })
  return Object.freeze({
    ...seed,
    caseID,
    legacyTaskID: caseID,
    fixture,
    fixtureDigest: digest(fixture),
    objective: replaceMultistackVariantText(seed.objective, threshold, maximum),
  })
}

const generatedMultistackCases: ReadonlyArray<GoldenCase> = multistackSeedCases.flatMap((seed) =>
  Array.from({ length: 4 }, (_, offset) => makeMultistackVariant(seed, offset + 2)),
)

export const GOLDEN_CASES: Readonly<Record<string, GoldenCase>> = Object.freeze({
  [pricingCase.caseID]: pricingCase,
  [inventoryCase.caseID]: inventoryCase,
  [slugCase.caseID]: slugCase,
  [retryCase.caseID]: retryCase,
  [stateCase.caseID]: stateCase,
  [refactorCase.caseID]: refactorCase,
  [architectureCase.caseID]: architectureCase,
  ...Object.fromEntries(generatedPythonFormalCases.map((goldenCase) => [goldenCase.caseID, goldenCase])),
  ...Object.fromEntries(generatedCapabilityEvalCases.map((goldenCase) => [goldenCase.caseID, goldenCase])),
  ...Object.fromEntries(generatedMultistackCases.map((goldenCase) => [goldenCase.caseID, goldenCase])),
  [multistackJavascriptCase.caseID]: multistackJavascriptCase,
  [multistackJavaCase.caseID]: multistackJavaCase,
  [multistackRustCase.caseID]: multistackRustCase,
  [multistackCCase.caseID]: multistackCCase,
  [multistackCppCase.caseID]: multistackCppCase,
  [multistackCsharpCase.caseID]: multistackCsharpCase,
  [multistackGoCase.caseID]: multistackGoCase,
  [multistackPhpCase.caseID]: multistackPhpCase,
  [multistackRubyCase.caseID]: multistackRubyCase,
  [multistackSqlCase.caseID]: multistackSqlCase,
})

export class InvalidGoldenCaseError extends Schema.TaggedErrorClass<InvalidGoldenCaseError>()(
  "RuntimeGolden.InvalidGoldenCaseError",
  { caseID: Schema.String, reason: Schema.String },
) {}

export class UnsupportedReplayKindError extends Schema.TaggedErrorClass<UnsupportedReplayKindError>()(
  "RuntimeGolden.UnsupportedReplayKindError",
  { kind: Schema.String },
) {}

export interface DeterministicReplayInput {
  readonly kind: "deterministic-tool-fixture"
  readonly goldenCase: GoldenCase
  readonly runID: AgentRuntime.RunID
  readonly traceID: string
  readonly sessionID: string
  readonly toolCallID: string
  readonly baselineArtifactDigest: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest: string
  readonly toolchainDigest: string
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly baselinePassed: boolean
  readonly actual: Readonly<Record<string, unknown>>
  readonly checks: ReadonlyArray<VerificationCheckInput>
}

export interface RecordedProviderFixtureInput {
  readonly providerID: string
  readonly modelID: string
  /** Digest of the normalized request; the prompt and credentials never enter this fixture. */
  readonly requestDigest: string
  readonly events: ReadonlyArray<LLMEventType>
}

export interface RecordedProviderFixture extends RecordedProviderFixtureInput {
  readonly fixtureDigest: string
}

const RecordedProviderFixtureSchema = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  requestDigest: Schema.String,
  events: Schema.Array(LLMEvent),
  fixtureDigest: Schema.String,
})

/** Create an immutable, content-addressed provider-event fixture for offline replay. */
export const makeRecordedProviderFixture = (input: RecordedProviderFixtureInput): RecordedProviderFixture => {
  const normalized = { ...input, events: [...input.events] }
  return Object.freeze({ ...normalized, events: Object.freeze(normalized.events), fixtureDigest: digest(normalized) })
}

/** Decode a JSON archive into the same immutable fixture contract used by replay. */
export const decodeRecordedProviderFixture = (input: unknown): RecordedProviderFixture =>
  Schema.decodeUnknownSync(RecordedProviderFixtureSchema as unknown as Schema.Decoder<unknown>)(input) as RecordedProviderFixture

export interface RecordedProviderReplayInput {
  readonly kind: "recorded-provider"
  readonly goldenCase: GoldenCase
  readonly fixture: RecordedProviderFixture
  /** Request digest supplied by the caller and checked against the immutable fixture. */
  readonly requestDigest: string
  readonly runID: AgentRuntime.RunID
  readonly traceID: string
  readonly sessionID: string
  readonly toolCallID: string
  readonly actionID?: string
  readonly baselineArtifactDigest: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest: string
  readonly toolchainDigest: string
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly baselinePassed: boolean
  readonly checks: ReadonlyArray<VerificationCheckInput>
}

export interface LiveModelAuthorization {
  readonly approved: boolean
  readonly actorID: string
  readonly reason: string
  /** Maximum spend in the caller's currency minor units for this one case. */
  readonly maxCostMinor: number
  readonly currency: string
}

export interface LiveModelReplayInput {
  readonly kind: "live-model"
  readonly goldenCase: GoldenCase
  readonly client: LLMClientShape
  readonly request: LLMRequest
  /** Digest of the normalized request; prompt text and credentials never enter telemetry. */
  readonly requestDigest: string
  readonly authorization: LiveModelAuthorization
  /** Provider/catalog estimate checked before the stream is constructed. */
  readonly estimatedCostMinor: number
  /** Settled provider charge supplied by the caller after the stream completes. */
  readonly actualCostMinor: number
  readonly runID: AgentRuntime.RunID
  readonly traceID: string
  readonly sessionID: string
  readonly toolCallID: string
  readonly actionID?: string
  readonly baselineArtifactDigest: string
  readonly candidateArtifactDigest: string
  readonly environmentDigest: string
  readonly toolchainDigest: string
  readonly evidenceIDs: ReadonlyArray<AgentRuntime.EvidenceID>
  readonly baselinePassed: boolean
  readonly checks: ReadonlyArray<VerificationCheckInput>
}

export interface ReplayResult {
  readonly kind: ReplayKind
  readonly caseID: string
  readonly fixtureDigest: string
  readonly assertionResults: ReadonlyArray<{ readonly id: string; readonly passed: boolean }>
  readonly checkResults: ReadonlyArray<{ readonly command: string; readonly passed: boolean }>
  readonly passed: boolean
  readonly score: number
  readonly evaluation: EvaluationCreateInput
}

export interface GoldenRegressionSnapshot {
  readonly caseID: string
  readonly suiteID: string
  readonly suiteRevision: number
  readonly caseRevision: number
  readonly fixtureDigest: string
  readonly passed: boolean
  readonly score: number
}

export interface GoldenRegressionComparison {
  readonly caseID: string
  readonly equivalent: boolean
  readonly blockingReasons: ReadonlyArray<string>
}

/**
 * Compare a candidate Golden result with its frozen baseline.
 * Any identity, fixture, pass/fail, or score regression blocks the candidate.
 */
export const compareGoldenRegression = (input: {
  readonly baseline: GoldenRegressionSnapshot
  readonly candidate: GoldenRegressionSnapshot
}): GoldenRegressionComparison => {
  const reasons: string[] = []
  const { baseline, candidate } = input
  if (!baseline.passed) reasons.push("baseline-not-passing")
  if (baseline.caseID !== candidate.caseID) reasons.push("case-identity")
  if (baseline.suiteID !== candidate.suiteID) reasons.push("suite-identity")
  if (baseline.suiteRevision !== candidate.suiteRevision) reasons.push("suite-revision")
  if (baseline.caseRevision !== candidate.caseRevision) reasons.push("case-revision")
  if (baseline.fixtureDigest !== candidate.fixtureDigest) reasons.push("fixture-digest")
  if (baseline.passed && !candidate.passed) reasons.push("candidate-not-passing")
  if (!Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1) reasons.push("candidate-score-invalid")
  if (candidate.score < baseline.score) reasons.push("score-regression")
  return { caseID: baseline.caseID, equivalent: reasons.length === 0, blockingReasons: reasons }
}

const assertionPasses = (assertion: Assertion, actual: unknown) => {
  if (assertion.kind === "equals") return actual === assertion.expected
  if (assertion.kind === "contains") {
    if (typeof actual === "string" && typeof assertion.expected === "string") return actual.includes(assertion.expected)
    return Array.isArray(actual) && actual.includes(assertion.expected)
  }
  if (typeof actual === "string" && typeof assertion.expected === "string") return !actual.includes(assertion.expected)
  return Array.isArray(actual) && !actual.includes(assertion.expected)
}

const digestPattern = /^(?:sha256:)?[a-f0-9]{40,128}$/i

const replayAssertions = (goldenCase: GoldenCase, actual: Readonly<Record<string, unknown>>) =>
  [...goldenCase.positiveAssertions, ...goldenCase.negativeAssertions].map((assertion) => ({
    id: assertion.id,
    passed: assertionPasses(assertion, actual[assertion.actualKey]),
  }))

const replayScore = (
  assertions: ReadonlyArray<{ readonly passed: boolean }>,
  verification: { readonly passed: boolean; readonly passedCount: number; readonly total: number },
) => {
  const totalAssertions = assertions.length
  const passedAssertions = assertions.filter((assertion) => assertion.passed).length
  const denominator = totalAssertions + verification.total
  return {
    passed: assertions.every((assertion) => assertion.passed) && verification.passed,
    score: denominator === 0 ? 0 : (passedAssertions + verification.passedCount) / denominator,
    passedAssertions,
    totalAssertions,
  }
}

const validateCase = (goldenCase: GoldenCase): Effect.Effect<void, InvalidGoldenCaseError> =>
  Effect.gen(function* () {
    const fail = (reason: string) => new InvalidGoldenCaseError({ caseID: goldenCase.caseID, reason })
    if (
      !goldenCase.suiteID.trim() ||
      !goldenCase.caseID.trim() ||
      !goldenCase.legacyTaskID.trim() ||
      !goldenCase.legacyCategory.trim()
    )
      return yield* fail("suite/case/legacy identity is required")
    if (
      !Number.isSafeInteger(goldenCase.suiteRevision) ||
      goldenCase.suiteRevision < 1 ||
      !Number.isSafeInteger(goldenCase.caseRevision) ||
      goldenCase.caseRevision < 1 ||
      !Number.isSafeInteger(goldenCase.legacyTimeoutSteps) ||
      goldenCase.legacyTimeoutSteps < 1
    )
      return yield* fail("suite/case revisions and legacy timeout must be positive integers")
    if (
      !goldenCase.objective.trim() ||
      !goldenCase.fixture.source.trim() ||
      !goldenCase.fixture.language.trim() ||
      !goldenCase.fixture.path.trim() ||
      !goldenCase.fixture.content.trim() ||
      !goldenCase.fixture.tests.trim()
    )
      return yield* fail("objective and fixture source fields are required")
    const supportingFiles = goldenCase.fixture.supportingFiles ?? []
    const fixturePaths = new Set([goldenCase.fixture.path])
    for (const file of supportingFiles) {
      if (!file.path.trim() || fixturePaths.has(file.path)) return yield* fail("fixture file paths must be unique")
      fixturePaths.add(file.path)
    }
    if (goldenCase.legacyExpectedFiles.length === 0 || goldenCase.legacyExpectedFiles.some((file) => !file.trim()))
      return yield* fail("legacy expected files are required")
    if (digest(goldenCase.fixture) !== goldenCase.fixtureDigest)
      return yield* fail("fixture digest mismatch")
    if (goldenCase.verifier.version !== "v1")
      return yield* fail("unsupported verifier revision")
    const assertions = [...goldenCase.positiveAssertions, ...goldenCase.negativeAssertions]
    if (assertions.length === 0) return yield* fail("case has no assertions")
    const assertionIDs = new Set<string>()
    for (const assertion of assertions) {
      if (!assertion.id.trim() || !assertion.actualKey.trim()) return yield* fail("assertion identity is required")
      if (assertionIDs.has(assertion.id)) return yield* fail("assertion IDs must be unique")
      assertionIDs.add(assertion.id)
    }
    if (
      !Number.isSafeInteger(goldenCase.budget.maxTokens) ||
      goldenCase.budget.maxTokens < 0 ||
      !Number.isSafeInteger(goldenCase.budget.maxCostMinor) ||
      goldenCase.budget.maxCostMinor < 0 ||
      !Number.isSafeInteger(goldenCase.budget.maxDurationMs) ||
      goldenCase.budget.maxDurationMs < 1
    )
      return yield* fail("budget must contain non-negative token/cost and positive duration limits")
    if (goldenCase.supportedPlatforms.length === 0 || goldenCase.supportedPlatforms.some((platform) => !platform.trim()))
      return yield* fail("supported platforms are required")
  })

export const replayDeterministic = Effect.fn("RuntimeGolden.replayDeterministic")(function* (
  input: DeterministicReplayInput,
) {
  if (input.kind !== "deterministic-tool-fixture") return yield* new UnsupportedReplayKindError({ kind: input.kind })
  yield* validateCase(input.goldenCase)
  const verification = yield* verify({
    runID: input.runID,
    traceID: input.traceID,
    sessionID: input.sessionID,
    toolCallID: input.toolCallID,
    claim: input.goldenCase.objective,
    checks: input.checks,
  })
  const assertions = replayAssertions(input.goldenCase, input.actual)
  const checkResults = verification.checks.map((check) => ({ command: check.command, passed: check.ok }))
  const scored = replayScore(assertions, verification.summary)
  const passed = scored.passed
  const score = scored.score
  const totalAssertions = scored.totalAssertions
  const passedAssertions = scored.passedAssertions
  const metrics = {
    assertion_pass_rate: totalAssertions === 0 ? 0 : passedAssertions / totalAssertions,
    verification_passed: verification.summary.passed ? 1 : 0,
    check_count: verification.summary.total,
  }
  RuntimeInsight.recordMetric({
    name: "evaluation.replay",
    value: passed ? 1 : 0,
    unit: "count",
    attributes: { runID: input.runID, traceID: input.traceID, caseID: input.goldenCase.caseID, kind: input.kind },
  })
  return {
    kind: input.kind,
    caseID: input.goldenCase.caseID,
    fixtureDigest: input.goldenCase.fixtureDigest,
    assertionResults: assertions,
    checkResults,
    passed,
    score,
    evaluation: {
      runID: input.runID,
      suiteID: input.goldenCase.suiteID,
      suiteRevision: input.goldenCase.suiteRevision,
      caseID: input.goldenCase.caseID,
      caseRevision: input.goldenCase.caseRevision,
      baselineArtifactDigest: input.baselineArtifactDigest,
      candidateArtifactDigest: input.candidateArtifactDigest,
      environmentDigest: input.environmentDigest,
      toolchainDigest: input.toolchainDigest,
      sampleSize: 1,
      score,
      successDelta: (passed ? 1 : 0) - (input.baselinePassed ? 1 : 0),
      costDelta: 0,
      latencyDelta: 0,
      passed,
      metrics,
      evidenceIDs: input.evidenceIDs,
      approvalStatus: "pending" as const,
    },
  }
})

const recordedProviderActual = (events: ReadonlyArray<LLMEventType>, response: LLMResponse) => {
  const usage = response.usage
  return {
    text: response.text,
    reasoning: response.reasoning,
    toolCallCount: response.toolCalls.length,
    toolResultCount: events.filter((event) => event.type === "tool-result").length,
    eventCount: events.length,
    stepCount: events.filter((event) => event.type === "step-start").length,
    finishReason: response.finishReason,
    hasProviderError: events.some((event) => event.type === "provider-error"),
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  } satisfies Readonly<Record<string, unknown>>
}

/** Replay recorded provider-neutral events through the production LLM response reducer. */
export const replayRecordedProvider = Effect.fn("RuntimeGolden.replayRecordedProvider")(function* (
  input: RecordedProviderReplayInput,
) {
  if (input.kind !== "recorded-provider") return yield* new UnsupportedReplayKindError({ kind: input.kind })
  yield* validateCase(input.goldenCase)
  if (
    !input.fixture.providerID.trim() ||
    !input.fixture.modelID.trim() ||
    !digestPattern.test(input.fixture.requestDigest) ||
    input.fixture.requestDigest !== input.requestDigest
  )
    return yield* new InvalidGoldenCaseError({ caseID: input.goldenCase.caseID, reason: "recorded request identity mismatch" })
  const fixturePayload = {
    providerID: input.fixture.providerID,
    modelID: input.fixture.modelID,
    requestDigest: input.fixture.requestDigest,
    events: input.fixture.events,
  }
  if (digest(fixturePayload) !== input.fixture.fixtureDigest)
    return yield* new InvalidGoldenCaseError({ caseID: input.goldenCase.caseID, reason: "recorded fixture digest mismatch" })
  const response = LLMResponse.fromEvents(input.fixture.events)
  if (response === undefined)
    return yield* new InvalidGoldenCaseError({ caseID: input.goldenCase.caseID, reason: "recorded events have no terminal finish" })
  const verification = yield* verify({
    runID: input.runID,
    traceID: input.traceID,
    sessionID: input.sessionID,
    toolCallID: input.toolCallID,
    ...(input.actionID ? { actionID: input.actionID } : {}),
    claim: input.goldenCase.objective,
    checks: input.checks,
  })
  const actual = recordedProviderActual(input.fixture.events, response)
  const assertions = replayAssertions(input.goldenCase, actual)
  const checkResults = verification.checks.map((check) => ({ command: check.command, passed: check.ok }))
  const scored = replayScore(assertions, verification.summary)
  const metrics = {
    assertion_pass_rate: scored.totalAssertions === 0 ? 0 : scored.passedAssertions / scored.totalAssertions,
    verification_passed: verification.summary.passed ? 1 : 0,
    check_count: verification.summary.total,
    event_count: input.fixture.events.length,
    step_count: actual.stepCount as number,
    tool_call_count: actual.toolCallCount as number,
    tool_result_count: actual.toolResultCount as number,
    input_tokens: actual.inputTokens as number,
    output_tokens: actual.outputTokens as number,
    total_tokens: actual.totalTokens as number,
  }
  RuntimeInsight.recordMetric({
    name: "evaluation.replay",
    value: scored.passed ? 1 : 0,
    unit: "count",
    attributes: {
      runID: input.runID,
      traceID: input.traceID,
      caseID: input.goldenCase.caseID,
      kind: input.kind,
      providerID: input.fixture.providerID,
      modelID: input.fixture.modelID,
      requestDigest: input.fixture.requestDigest,
      eventCount: input.fixture.events.length,
      stepCount: actual.stepCount,
      toolCallCount: actual.toolCallCount,
    },
  })
  return {
    kind: input.kind,
    caseID: input.goldenCase.caseID,
    fixtureDigest: input.fixture.fixtureDigest,
    assertionResults: assertions,
    checkResults,
    passed: scored.passed,
    score: scored.score,
    evaluation: {
      runID: input.runID,
      suiteID: input.goldenCase.suiteID,
      suiteRevision: input.goldenCase.suiteRevision,
      caseID: input.goldenCase.caseID,
      caseRevision: input.goldenCase.caseRevision,
      baselineArtifactDigest: input.baselineArtifactDigest,
      candidateArtifactDigest: input.candidateArtifactDigest,
      environmentDigest: input.environmentDigest,
      toolchainDigest: input.toolchainDigest,
      sampleSize: 1,
      score: scored.score,
      successDelta: (scored.passed ? 1 : 0) - (input.baselinePassed ? 1 : 0),
      costDelta: 0,
      latencyDelta: 0,
      passed: scored.passed,
      metrics,
      evidenceIDs: input.evidenceIDs,
      providerID: input.fixture.providerID,
      modelID: input.fixture.modelID,
      inputTokens: actual.inputTokens as number,
      outputTokens: actual.outputTokens as number,
      approvalStatus: "pending" as const,
    },
  }
})

/**
 * Run one explicitly authorized live model case through the same reducer and
 * verifier as recorded replay. The client is injected so policy and billing
 * gates can be tested without granting this module credentials or network
 * access. No live provider is called unless every pre-call gate passes.
 */
export const replayLiveModel = Effect.fn("RuntimeGolden.replayLiveModel")(function* (
  input: LiveModelReplayInput,
) {
  if (input.kind !== "live-model") return yield* new UnsupportedReplayKindError({ kind: input.kind })
  yield* validateCase(input.goldenCase)
  const fail = (reason: string) => new InvalidGoldenCaseError({ caseID: input.goldenCase.caseID, reason })
  const authorization = input.authorization
  if (
    input.goldenCase.budget.maxTokens < 1 ||
    input.goldenCase.budget.maxCostMinor < 1 ||
    !authorization.approved ||
    !authorization.actorID.trim() ||
    !authorization.reason.trim() ||
    !authorization.currency.trim()
  )
    return yield* fail("live model requires explicit authorization and a positive case budget")
  if (
    !Number.isSafeInteger(authorization.maxCostMinor) ||
    authorization.maxCostMinor < 0 ||
    authorization.maxCostMinor > input.goldenCase.budget.maxCostMinor
  )
    return yield* fail("live authorization exceeds the case cost budget")
  if (
    !Number.isSafeInteger(input.estimatedCostMinor) ||
    input.estimatedCostMinor < 0 ||
    input.estimatedCostMinor > authorization.maxCostMinor
  )
    return yield* fail("live estimated cost exceeds the authorized budget")
  if (
    !Number.isSafeInteger(input.actualCostMinor) ||
    input.actualCostMinor < 0 ||
    input.actualCostMinor > authorization.maxCostMinor
  )
    return yield* fail("live settled cost exceeds the authorized budget")
  if (!digestPattern.test(input.requestDigest)) return yield* fail("live request digest is invalid")

  const providerID = String(input.request.model.provider)
  const modelID = String(input.request.model.id)
  if (!providerID.trim() || !modelID.trim()) return yield* fail("live model identity is required")

  const startedAt = Date.now()
  const collected = yield* Effect.timeout(
    Stream.runCollect(input.client.stream(input.request)),
    input.goldenCase.budget.maxDurationMs,
  )
  if (collected === undefined) return yield* fail("live model exceeded the case duration budget")
  const events = Array.from(collected)
  const elapsedMs = Date.now() - startedAt
  const response = LLMResponse.fromEvents(events)
  if (response === undefined) return yield* fail("live events have no terminal finish")
  const usage = response.usage
  if (usage === undefined || usage.totalTokens === undefined)
    return yield* fail("live response has no provider token usage")
  if (
    usage.totalTokens < 0 ||
    !Number.isSafeInteger(usage.totalTokens) ||
    usage.totalTokens > input.goldenCase.budget.maxTokens
  )
    return yield* fail("live provider token usage exceeds the case budget")

  const verification = yield* verify({
    runID: input.runID,
    traceID: input.traceID,
    sessionID: input.sessionID,
    toolCallID: input.toolCallID,
    ...(input.actionID ? { actionID: input.actionID } : {}),
    claim: input.goldenCase.objective,
    checks: input.checks,
  })
  const actual = recordedProviderActual(events, response)
  const assertions = replayAssertions(input.goldenCase, actual)
  const checkResults = verification.checks.map((check) => ({ command: check.command, passed: check.ok }))
  const scored = replayScore(assertions, verification.summary)
  const fixture = makeRecordedProviderFixture({ providerID, modelID, requestDigest: input.requestDigest, events })
  const metrics = {
    assertion_pass_rate: scored.totalAssertions === 0 ? 0 : scored.passedAssertions / scored.totalAssertions,
    verification_passed: verification.summary.passed ? 1 : 0,
    check_count: verification.summary.total,
    event_count: events.length,
    step_count: actual.stepCount as number,
    tool_call_count: actual.toolCallCount as number,
    tool_result_count: actual.toolResultCount as number,
    input_tokens: actual.inputTokens as number,
    output_tokens: actual.outputTokens as number,
    total_tokens: actual.totalTokens as number,
    cost_minor: input.actualCostMinor,
    latency_ms: elapsedMs,
  }
  RuntimeInsight.recordMetric({
    name: "evaluation.replay",
    value: scored.passed ? 1 : 0,
    unit: "count",
    attributes: {
      runID: input.runID,
      traceID: input.traceID,
      caseID: input.goldenCase.caseID,
      kind: input.kind,
      providerID,
      modelID,
      requestDigest: input.requestDigest,
      fixtureDigest: fixture.fixtureDigest,
      eventCount: events.length,
      totalTokens: usage.totalTokens,
      costMinor: input.actualCostMinor,
      latencyMs: elapsedMs,
    },
  })
  return {
    kind: input.kind,
    caseID: input.goldenCase.caseID,
    fixtureDigest: fixture.fixtureDigest,
    assertionResults: assertions,
    checkResults,
    passed: scored.passed,
    score: scored.score,
    evaluation: {
      runID: input.runID,
      suiteID: input.goldenCase.suiteID,
      suiteRevision: input.goldenCase.suiteRevision,
      caseID: input.goldenCase.caseID,
      caseRevision: input.goldenCase.caseRevision,
      baselineArtifactDigest: input.baselineArtifactDigest,
      candidateArtifactDigest: input.candidateArtifactDigest,
      environmentDigest: input.environmentDigest,
      toolchainDigest: input.toolchainDigest,
      sampleSize: 1,
      score: scored.score,
      successDelta: (scored.passed ? 1 : 0) - (input.baselinePassed ? 1 : 0),
      costDelta: input.actualCostMinor,
      latencyDelta: elapsedMs,
      passed: scored.passed,
      metrics,
      evidenceIDs: input.evidenceIDs,
      providerID,
      modelID,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMinor: input.actualCostMinor,
      currency: authorization.currency,
      approvalStatus: "pending" as const,
    },
  }
})
