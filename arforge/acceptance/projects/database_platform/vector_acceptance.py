import sys

import chromadb

suite = sys.argv[1]
client = chromadb.EphemeralClient()
collection = client.create_collection(f"acceptance-{suite}")
collection.add(
    ids=["project", "unrelated"],
    documents=["arforge project depth", "other"],
    embeddings=[[1.0, 0.0], [0.0, 1.0]],
)
if suite == "integration":
    result = collection.query(query_embeddings=[[0.9, 0.1]], n_results=1)
    assert result["ids"] == [["project"]]
elif suite == "negative":
    try:
        collection.add(
            ids=["invalid"],
            documents=["bad"],
            embeddings=[[1.0, 0.0, 0.0]],
        )
    except Exception:
        pass
    else:
        raise AssertionError("dimension mismatch was accepted")
    assert collection.count() == 2
else:
    raise SystemExit(2)
print(f"PASS:{suite}")
