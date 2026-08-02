"""P1-7 向量记忆验收测试（离线）。

覆盖：VectorMemory 语义召回 / 更新同 id / recall_text 拼接 / 空记忆 /
记忆压缩 compress_memories（含失败兜底）。
"""

from arforge.memory_vector import VectorMemory, compress_memories, load_from_store
from arforge.retrieval import HashingEmbedding


def _mem():
    vm = VectorMemory(embedder=HashingEmbedding())
    vm.add("m1", "用户最喜欢的编程语言是 Python，主要用于后端开发")
    vm.add("m2", "用户的项目部署在 AWS 云服务器上")
    vm.add("m3", "用户每天早上九点开始工作")
    return vm


def test_vector_memory_recall_relevant():
    vm = _mem()
    hits = vm.recall("Python 编程语言", top_k=1)
    assert hits[0]["id"] == "m1"
    assert "Python" in hits[0]["content"]


def test_vector_memory_recall_deployment():
    vm = _mem()
    hits = vm.recall("项目部署在哪里 AWS", top_k=1)
    assert hits[0]["id"] == "m2"


def test_vector_memory_empty_recall():
    vm = VectorMemory(embedder=HashingEmbedding())
    assert vm.recall("anything") == []
    assert len(vm) == 0


def test_vector_memory_update_same_id():
    vm = VectorMemory(embedder=HashingEmbedding())
    vm.add("m1", "旧内容")
    vm.add("m1", "新内容覆盖")
    assert len(vm) == 1
    hits = vm.recall("新内容", top_k=1)
    assert hits[0]["content"] == "新内容覆盖"


def test_vector_memory_recall_text():
    vm = _mem()
    text = vm.recall_text("Python AWS 工作", top_k=3)
    assert "Python" in text or "AWS" in text
    assert "\n" in text  # 多条用换行拼接


class _FakeAdapter:
    def generate(self, messages, **kwargs):
        return "摘要：用户偏好 Python 后端，项目在 AWS，作息规律。"


def test_compress_memories():
    summary = compress_memories(_FakeAdapter(), ["用户喜欢 Python", "项目在 AWS", "九点上班"])
    assert "摘要" in summary
    assert compress_memories(_FakeAdapter(), []) == ""


def test_compress_memories_failure_fallback():
    class _BrokenAdapter:
        def generate(self, messages, **kwargs):
            raise RuntimeError("api down")

    out = compress_memories(_BrokenAdapter(), ["x"])
    assert "记忆压缩失败" in out


def test_compress_memories_samples_beginning_middle_and_end_without_prefix_bias():
    captured = {}

    class CaptureAdapter:
        def generate(self, messages, **_kwargs):
            captured["prompt"] = messages[0]["content"]
            return "summary"

    items = [f"ENTRY-{index:04d} " + ("x" * 120) for index in range(1_000)]
    assert compress_memories(CaptureAdapter(), items, max_input_chars=6_000) == "summary"

    prompt = captured["prompt"]
    assert "ENTRY-0000" in prompt
    assert any(f"ENTRY-{index:04d}" in prompt for index in range(450, 551))
    assert "ENTRY-0999" in prompt


def test_load_from_store_scopes_memories_to_workspace(monkeypatch):
    captured = {}

    def fake_query_memories(**kwargs):
        captured.update(kwargs)
        return [{"id": 1, "content": "workspace fact"}]

    monkeypatch.setattr("arforge.memory.query_memories", fake_query_memories)

    assert load_from_store(workspace_path=r"D:\project-a") == [("1", "workspace fact")]
    assert captured["workspace_path"] == r"D:\project-a"
