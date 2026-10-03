# Step 8.10 候选发布可重复性证据（2026-08-14）

- checkpoint：`5a442921`
- `SOURCE_DATE_EPOCH`：`1786732800`
- 输出目录：
  - `artifacts/release-evidence-stage8-local-latest`
  - `artifacts/release-evidence-stage8-local-repeat`
- 工作树含既有用户未提交变化，因此本结果是 candidate，不是可发布 signed artifact。

## 命令

```powershell
bun run release:evidence -- --output artifacts/release-evidence-stage8-local-latest \
  --allow-dirty --channel candidate --source-date-epoch 1786732800
bun run release:evidence:verify -- --output artifacts/release-evidence-stage8-local-latest

bun run release:evidence -- --output artifacts/release-evidence-stage8-local-repeat \
  --allow-dirty --channel candidate --source-date-epoch 1786732800
bun run release:evidence:verify -- --output artifacts/release-evidence-stage8-local-repeat
```

## 结果

两次构建均为 `candidate`，验证各通过 4 个 evidence files。以下五个文件的 SHA-256 在两个输出目录中完全一致：

- `SHA256SUMS`: `4c8b832bbb496e82b7187e1b2c904d3e58f48ffa4be67d65787f78b391ab2597`
- `provenance.json`: `fa6e1c346184f24010dfa2963feec9085667ad925aab8656df282d78b7e962df`
- `sbom.cdx.json`: `8fcc350ef77164ce129a7242b3ba38a854505c07cd2a72c221e342eb83dc170f`
- `signature-status.json`: `b81be1f4bb67c5daed2def4f9dd1cbb28930269f6cc23365539772f8103d4cba`
- `release-manifest.json`: `0e86fc884168f368c5d5464fb909a35a28e14da27e4d91c1738fc293a4a42a9a`

SLO fixture评估为 `SHIP`、0 active alerts；但发布门禁仍为 `DO_NOT_SHIP`，失败项为 `signedReleaseEvidence`、`canary`、`releaseOwner`。没有签名或 staging 证据被伪造。
