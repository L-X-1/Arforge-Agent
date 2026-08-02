from arforge.memory import init_memory_db, save_memory_v2
from arforge.learning_v2 import (
    init_learning_v2_db,
    learn_error_pattern,
    learn_from_conversation,
)


def main():
    init_memory_db()
    init_learning_v2_db()

    items = [
        (
            "\u005b2026-06-14 Codex dogfooding\u005d Arforge \u8bad\u7ec3\u89c4\u5219\uff1a\u4e0d\u8981\u628a\u6a21\u5757\u53ef\u5bfc\u5165\u5f53\u6210\u771f\u5b9e\u53ef\u7528\uff1b\u5fc5\u987b\u533a\u5206 import\u3001doctor\u3001script-test\u3001pytest\u3001real-cli\u3001dogfood \u516d\u5c42\u8bc1\u636e\u3002",
            "training,quality,evidence,codex-dogfood",
        ),
        (
            "\u005b2026-06-14 Codex dogfooding\u005d Arforge \u8981\u5411 Codex \u5bf9\u6807\uff0c\u77ed\u671f\u4e0d\u662f\u8bad\u7ec3\u6a21\u578b\u6743\u91cd\uff0c\u800c\u662f\u5efa\u7acb\u8bc4\u6d4b\u96c6\u3001\u4fee\u590d\u8d28\u91cf\u95e8\u7981\u3001\u79ef\u7d2f dogfooding outcome\u3001\u5199\u5165\u9ad8\u8d28\u91cf\u8bb0\u5fc6\u548c\u9519\u8bef\u6a21\u5f0f\u3002",
            "training,codex,agent-quality",
        ),
        (
            "\u005b2026-06-14 Codex dogfooding\u005d \u57fa\u7840 CLI \u5b9e\u6d4b\uff1aarforge --version\u3001arforge --help\u3001arforge doctor --json \u53ef\u7528\uff1bdoctor \u62a5 41 \u9879\u6b63\u5e38\uff1bprivacy/export \u53ef\u7528\uff0c\u4f46\u9690\u79c1\u626b\u63cf\u53d1\u73b0 .env \u4e2d\u5b58\u5728 API Key\u3002",
            "dogfood,cli,doctor,privacy",
        ),
        (
            "\u005b2026-06-14 Codex dogfooding\u005d \u8d28\u91cf\u95e8\u7981\u5b9e\u6d4b\uff1a\u6807\u51c6 pytest \u4e0d\u53ef\u7528\uff0c\u539f\u56e0\u5305\u62ec\u811a\u672c\u5f0f\u6d4b\u8bd5\u5b9a\u4e49 def test(name, condition) \u88ab pytest \u5f53\u6210\u6d4b\u8bd5\u51fd\u6570\uff0c\u4ee5\u53ca\u591a\u4e2a\u6587\u4ef6\u5728\u9876\u5c42 sys.exit(1)\u3002",
            "dogfood,pytest,p0",
        ),
        (
            "\u005b2026-06-14 Codex dogfooding\u005d \u811a\u672c\u5f0f\u81ea\u6d4b\u901a\u8fc7\uff1aMemoryV2 41/41\u3001ContextV2 66/66\u3001VerifierV2 79/79\u3001Recovery 58/58\u3001Doctor 33/33\u3001CapabilityRegistry 84/84\u3001MultimodalAdapters 43/43\u3002",
            "dogfood,script-tests,passed",
        ),
        (
            "\u005b2026-06-14 Codex dogfooding\u005d \u5931\u8d25\u70b9\uff1aCapabilityRouter 57/59\uff0cmemory_write \u548c engine.should_enhance \u5224\u65ad\u5931\u8d25\uff1bDataTools 62/69\uff0cmatplotlib \u672a\u5b89\u88c5\u4e14\u56fe\u8868\u751f\u6210\u94fe\u8def\u5931\u8d25\u3002",
            "dogfood,failures,capability,data-tools",
        ),
        (
            "\u005b2026-06-14 Codex dogfooding\u005d \u4e0b\u4e00\u6b65\u5bf9\u9f50\u76ee\u6807\uff1a\u5148\u4fee Step196 \u8d28\u91cf\u95e8\u7981\u548c\u5d29\u6e83\u515c\u5e95\uff0c\u518d\u505a Step197 \u9996\u6b21\u914d\u7f6e\uff0cStep198 dogfooding \u6570\u636e\u91c7\u96c6\uff0cStep199 \u5185\u90e8 RC Go/No-Go\u3002",
            "training,roadmap,step196-199",
        ),
    ]

    for content, tags in items:
        mid = save_memory_v2(
            content=content,
            mem_type="project",
            tags=tags,
            importance=5,
            source="codex_dogfood_training_utf8",
        )
        print(f"memory_id={mid} tags={tags}")

    learn_error_pattern(
        "pytest collection fails because script-style test files define def test(name, condition), causing fixture 'name' not found",
        "Rename the helper function to check/assert_case or mark it non-test; convert script assertions into pytest-native test functions.",
        success=True,
    )
    learn_error_pattern(
        "pytest INTERNALERROR because test_data_tools.py or test_battle_scenarios.py calls sys.exit(1) at module import",
        "Move sys.exit under if __name__ == '__main__' or replace top-level exits with pytest assertions.",
        success=True,
    )
    learn_error_pattern(
        "Arforge data chart generation returns data format unsupported for bar/line/pie/hist/scatter",
        "Install matplotlib in project requirements or provide robust ASCII fallback; normalize chart input schema and add per-chart tests.",
        success=True,
    )
    learn_from_conversation(
        "\u7528\u6237\u8981\u6c42\u8bad\u7ec3 Arforge \u50cf Codex \u4e00\u6837\u5f3a\u5e76\u51fb\u8d25\u7ade\u54c1",
        "\u5b9e\u9645\u53ef\u6267\u884c\u8def\u7ebf\u662f dogfooding + eval harness + memory/learning seeding + quality gate + targeted fixes\uff0c\u800c\u4e0d\u662f\u5728\u672c\u5730\u76f4\u63a5\u8bad\u7ec3\u6a21\u578b\u6743\u91cd\u3002",
    )
    print("utf8_training_seed_done")


if __name__ == "__main__":
    main()
