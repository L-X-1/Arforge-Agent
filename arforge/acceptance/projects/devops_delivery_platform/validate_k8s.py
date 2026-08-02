from pathlib import Path

import yaml

deployment = yaml.safe_load(Path("k8s/deployment.yaml").read_text(encoding="utf-8"))
service = yaml.safe_load(Path("k8s/service.yaml").read_text(encoding="utf-8"))

assert deployment["apiVersion"] == "apps/v1"
assert deployment["kind"] == "Deployment"
assert deployment["spec"]["replicas"] >= 2
container = deployment["spec"]["template"]["spec"]["containers"][0]
assert container["readinessProbe"]["httpGet"] == {
    "path": "/health",
    "port": 8080,
}
assert container["securityContext"]["allowPrivilegeEscalation"] is False
assert container["securityContext"]["capabilities"]["drop"] == ["ALL"]
assert service["spec"]["ports"][0]["targetPort"] == 8080
assert service["spec"]["selector"] == deployment["spec"]["selector"]["matchLabels"]
print("PASS:Kubernetes")
