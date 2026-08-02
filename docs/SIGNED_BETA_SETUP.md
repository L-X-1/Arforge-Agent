# 第二阶段：Windows 签名 Beta 获取与配置指南

本阶段只把安装包交给少量受邀测试者，不创建公开 GitHub Release，也不挂到官网。

## 先确认你要购买的东西

推荐购买 **DigiCert Code Signing + KeyLocker**，不是 USB Token 版，也不是普通
SSL/TLS 网站证书。KeyLocker 把代码签名私钥保存在云 HSM 中，GitHub Actions
只拿到签名权限，拿不到可导出的代码签名私钥。

截至 2026-08-02，DigiCert 中国站列出的 Code Signing + KeyLocker 价格为
US$996/年，包含 1,000 次签名；价格和税费以结算页为准。不要先买 EV：Arforge
当前不签内核驱动，先用标准组织验证（OV）通常足够。

如果你没有可验证的公司、个体工商户或其他法律实体，先不要付款。可以改走
SSL.com 的 IV Code Signing + eSigner 个人验证路线，但需要先让供应商书面确认
中国大陆个人身份、GitHub Actions 和 Windows Authenticode 均可用，再调整流水线。

Microsoft Artifact Signing 暂不作为中国大陆主体的购买路线：其 Public Trust
当前仅支持美国、加拿大、欧盟、英国的组织，以及美国、加拿大的个人开发者。
Private Trust 不能用于面向普通 Windows 用户的公开下载。

## 你需要提前准备的材料

1. 营业执照或其他法律实体登记材料，名称、地址必须与申请信息完全一致。
2. 能代表该实体申请证书的联系人身份证明和授权关系。
3. 可由第三方来源核验的公司电话；DigiCert 会通过公开号码回拨确认权限。
4. 公司域名、可正常访问的网站，以及同域名的收件邮箱。
5. 可进行外币或跨境支付的付款方式，以及开票/税务信息。
6. 一个不同于工作流发起人的 GitHub 审核人。若暂时只有你一个维护者，先邀请
   一个可信协作者；不要用第二个自己的账号伪造双人审核。

## 第 1 步：申请证书和 KeyLocker

1. 打开 DigiCert 的 Code Signing 产品页。
2. 选择 `Code Signing + KeyLocker` 和 1 年期限。
3. 验证级别先选标准组织验证（OV），不要选择 USB Token、Own Token 或自有 HSM。
4. 证书主体名称填写营业执照上的法定全称。这个名称以后会显示在 Windows 的
   “发布者”位置，不能填写品牌简称 `Arforge`，除非它就是已验证的法律名称。
5. 提交组织和联系人验证，留意公司邮箱、电话和补充材料请求。
6. 证书签发后，在 DigiCert ONE / KeyLocker 中确认存在一个带默认证书的 keypair。

完成后记录三项非秘密值：

- Keypair alias
- 证书完整 Subject，例如 `CN=某某科技有限公司, O=某某科技有限公司, C=CN`
- DigiCert ONE 的 client-auth host，通常由账户所在环境给出

## 第 2 步：创建专用 CI 身份

建议创建权限最小化的 service user，不要把个人管理员 API token 长期放进 CI。
它只需要查看指定 keypair/certificate 和签名权限。

在 DigiCert ONE 中为该身份创建：

1. API key。它只显示一次，立即放入密码管理器。
2. Client authentication certificate（`.p12`）。选择 AES 和 SHA-256，设置明确
   的到期日，下载后保存；文件和密码都只提供一次。
3. 记录证书/API key 的到期日，在到期前 30 天轮换。

这里的 `.p12` 是访问 KeyLocker 的客户端身份，不含 Arforge 的代码签名私钥。
代码签名私钥始终留在云 HSM 中。

把 `.p12` 转为 GitHub Secret 所需的 Base64：

```powershell
[Convert]::ToBase64String(
  [IO.File]::ReadAllBytes("C:\安全目录\arforge-ci-client.p12")
) | Set-Clipboard
```

不要把 Base64、API key、密码发到聊天、Issue、日志或提交进 Git。

## 第 3 步：准备 GitHub 受保护环境

仓库必须已推送到 GitHub，并且你拥有管理员权限。私有仓库要先确认当前 GitHub
计划支持 Environment secrets；required reviewers 在私有仓库中的可用性还取决于
计划，界面没有该选项时需要升级相应组织计划或暂时停止签名发布。

进入：`Repository > Settings > Environments > New environment`，名称必须是：

```text
desktop-release-candidate
```

配置：

1. 添加至少一名 Required reviewer。
2. 开启 Prevent self-review。
3. 禁止管理员绕过保护规则（计划支持时）。
4. Deployment branches/tags 只允许受保护的发布分支或发布标签。

在该 Environment 的 **Variables** 中添加：

| 名称 | 值 |
| --- | --- |
| `SM_HOST` | DigiCert ONE client-auth host |
| `ARFORGE_WINDOWS_KEYPAIR_ALIAS` | KeyLocker keypair alias |
| `ARFORGE_WINDOWS_EXPECTED_SIGNER_SUBJECT` | Windows 证书完整 Subject |

在该 Environment 的 **Secrets** 中添加：

| 名称 | 值 |
| --- | --- |
| `SM_API_KEY` | 专用 CI 身份的 API key |
| `SM_CLIENT_CERT_FILE_B64` | `.p12` 文件的 Base64 |
| `SM_CLIENT_CERT_PASSWORD` | `.p12` 密码 |

## 第 4 步：运行首个签名候选包

1. 确保要发布的提交已经评审、工作树干净并推送到允许的分支。
2. 打开 `Actions > Desktop signed Beta candidate > Run workflow`。
3. 另一名审核人在 Environment 审批界面核对提交后批准。
4. 流水线会执行桌面行为测试、构建 Beta、通过云 HSM 签名、删除 runner 上的
   客户端认证文件、校验 Authenticode 与 RFC 3161 时间戳，并上传 14 天保留的私有
   Actions artifact。
5. 任何签名主体不匹配、缺少时间戳或凭据未删除都会失败，不得把失败运行中的
   安装包交给测试者。

## 第 5 步：人工验收并小范围分发

下载 Actions artifact，在一台没有开发环境的 Windows 11 机器上执行：

```powershell
$installer = "C:\下载目录\arforge-desktop-win-x64.exe"
Get-AuthenticodeSignature -LiteralPath $installer |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

必须看到 `Status : Valid`、正确的法定发布者和非空时间戳证书。然后完成安装、启动、
创建会话、调用一个低风险工具、退出、重新打开和卸载测试。仅把这个经过验证的文件
发给明确受邀的 Beta 用户，并同时提供 SHA-256；暂不允许公开链接传播。

## 暂时不要做

- 不要购买 USB Token 版后尝试塞进 GitHub 托管 runner。
- 不要把代码签名私钥、PFX 或任何密码提交到仓库。
- 不要用自签名证书替代公开信任签名。
- 不要因为显示了公司名称就承诺 SmartScreen 一定不警告；信誉仍需实际观察。
- 不要启用官网公开下载、自动更新或公开 GitHub Release。

## 官方资料

- DigiCert Code Signing + KeyLocker：<https://www.digicert.com/cn/signing/compare-code-signing-certificates>
- DigiCert 组织验证：<https://docs.digicert.com/en/certcentral/get-started/understand-how-certcentral-works/understand-certificate-validation/validation-levels-in-certcentral/organization-validation--ov-.html>
- DigiCert KeyLocker signer guide：<https://docs.digicert.com/en/digicert-keylocker/get-started/signer-guide.html>
- DigiCert Electron Builder 集成：<https://docs.digicert.com/en/digicert-keylocker/code-signing/sign-with-third-party-signing-tools/windows-applications/sign-executables-with-electron-builder-using-ksp-library.html>
- GitHub Environments：<https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments>
- Microsoft Artifact Signing 限制：<https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart>
