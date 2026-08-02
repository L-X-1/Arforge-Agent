# Arforge Agent 浜у搧瀹¤涓庣户缁紑鍙戝熀绾?
鏃ユ湡锛?026-06-18
鐗堟湰锛?.7.0 Alpha
鐩爣锛氬厛杈惧埌绋冲畾銆佸彲瀹夎銆佸彲璇婃柇銆佸彲鎭㈠鐨?CLI 鍐呴儴 RC锛屽啀杩涘叆妗岄潰绔紑鍙戙€?
## 鏈疆鐪熷疄楠屾敹缁撴灉

| 闂ㄧ | 缁撴灉 | 缁撹 |
|---|---:|---|
| pytest | 594 passed / 0 failed | 閫氳繃锛岃€楁椂绾?4 鍒嗛挓 |
| Ruff | 0 issues | 閫氳繃 |
| compileall | arforge | 閫氳繃 |
| wheel | arforge_agent-0.7.0-py3-none-any.whl | 鏋勫缓閫氳繃 |
| CLI help/version | 鍙繍琛?| 閫氳繃锛屽綋鍓嶆槑纭爣璁?Alpha |
| Doctor | 14 OK / 2 WARN | 鍙敤锛屼絾妫€鏌ユ繁搴︿粛涓嶈冻 |

鏈疆寮€濮嬫椂锛屽紑鍙戠姸鎬佹枃浠朵腑鐨?`591 passed / 3 pre-existing failures / Ruff CLEAN`
宸茬粡涓庡伐浣滃尯涓嶄竴鑷淬€傚疄闄呴娆″畬鏁村洖褰掍负 `590 passed / 4 failed`锛岄殢鍚庝慨澶嶅苟杈惧埌涓婅堪鍩虹嚎銆?
## 鏈疆淇

1. Windows 涓?`echo` 鏄?shell builtin锛屽師鏃?shell 鎵ц鍣ㄤ細鎶?`WinError 2`銆傜幇鍦ㄧ敱瀹夊叏鎵ц灞傜洿鎺ュ疄鐜帮紝涓嶆斁瀹?shell 杈圭晫銆?2. `run_cmd`銆乣read_file`銆乣write_file` 鐨勫け璐ヤ笉鍐嶈 ToolRegistry 璇姤涓烘垚鍔熴€?3. 鍐欐枃浠舵祴璇曞繀椤绘樉寮忚缃?`ARFORGE_AUTO_APPROVE=1`锛屼笉鍐嶄緷璧栧亣纭鎴栨祴璇曠幆澧冨伓鐒剁姸鎬併€?4. Python AST 绱㈠紩澧炲姞鏍圭洰褰曠敓鍛藉懆鏈熸鏌ワ紝閬垮厤宸插垹闄や复鏃堕」鐩薄鏌撳悗缁伐浣滃尯鏌ヨ锛屽悓鏃朵繚鐣欐湁鏁堢殑鏄惧紡绱㈠紩銆?5. 鍗曞厓娴嬭瘯涓嶅啀鍥犳湰鏈哄瓨鍦?API Key 鑰屽彂璧风湡瀹炴ā鍨嬭姹傦紱鐪熷疄鑱旂綉楠岃瘉搴旀斁鍏ュ彲閫?E2E 濂椾欢銆?6. 娓呯悊 19 涓?Ruff 闂鍜?TesterAgent 鐨?pytest 璇敹闆嗚鍛娿€?7. 鍖呭垎绫讳粠 Beta 璋冩暣涓轰笌瀹為檯鍙戝竷闃舵涓€鑷寸殑 Alpha銆?
## 褰撳墠鏋舵瀯鍦板浘

- `arforge/core/`锛氬崟 Agent 鏍稿績銆佷簨浠躲€佸搷搴斻€佹墽琛屽惊鐜€?- `arforge/multiagent/`锛歁asterAgent銆丏ispatcher銆丮erger銆? 绫诲瓙 Agent 鍜屽崗浣滄ā寮忋€?- `arforge/tools/` + `tool_registry.py`锛氬伐鍏锋敞鍐屻€佸弬鏁伴€傞厤銆佹墽琛屽拰缁撴灉鍖呰銆?- `arforge/capability/`锛氳兘鍔涜矾鐢便€佽瀺鍚堛€佸寮烘祦姘寸嚎銆?- `arforge/planning/` + `reasoning/`锛氳鍒掔敓鎴愩€佸伐浣滄祦鍜岀粨鏋勫寲鎺ㄧ悊銆?- `arforge/security/`锛氱‘璁ゃ€佹枃浠朵簨鍔°€乨iff銆佸浠姐€佹仮澶嶅拰娌欑杈圭晫銆?- `arforge/database/` + memory/learning锛歋QLite/PostgreSQL銆佽蹇嗗拰瀛︿範闂幆銆?- `arforge/multimodal.py`锛氬浘鐗囥€丱CR銆佹枃妗ｈ兘鍔?facade銆?- `arforge/cli.py` + `cli_ui.py`锛氬綋鍓嶉瑕佷骇鍝佺晫闈€?- `arforge/`锛氭棫鍝佺墝鍏煎鍛藉悕绌洪棿锛屽彂甯冨墠蹇呴』鎸佺画鍋氬吋瀹瑰洖褰掋€?
## 涓婄嚎闃绘柇椤?
### P0锛欳LI 鍐呴儴 RC 鍓嶅繀椤诲畬鎴?
1. 澧炲姞 CI锛歅ython 3.10/3.11/3.12锛學indows/Linux锛宲ytest + Ruff + wheel + 瀹夎鍚?CLI smoke銆?2. 寤虹珛闅旂鐢ㄦ埛鐩綍 E2E锛氶娆″惎鍔ㄣ€佷俊浠诲睆骞曘€乷nboarding銆佹棤 API Key銆侀敊璇?API Key銆佸彧璇荤洰褰曘€侀潪 TTY銆?3. Doctor 鎵╁睍鍒板畨瑁呫€佺綉缁溿€佹ā鍨嬨€佹暟鎹簱銆佺鐩樸€佹潈闄愩€佺紪鐮併€佸彲閫変緷璧栥€佸寘涓€鑷存€э紝骞舵彁渚涘畨鍏ㄧ殑 `--fix`銆?4. 鐪熷疄浠诲姟鍥炲綊鍜屽彲閫夎仈缃戞祴璇曞垎灞傦紱榛樿娴嬭瘯蹇呴』瀹屽叏绂荤嚎銆佺‘瀹氥€佸彲瓒呮椂銆?5. 娓呯悊浠撳簱鏍圭洰褰曠枒浼艰鐢熸垚鏂囦欢锛屾暣鐞嗗綋鍓嶅ぇ閲忔湭鎻愪氦淇敼鍚庡缓绔嬪彲淇?Git 鍩虹嚎銆?6. 瀹屾垚闅愮鎵弿銆佸鍑恒€侀仴娴嬮粯璁ゅ叧闂€佸穿婧冩棩蹇楄劚鏁忓拰鏁忔劅淇℃伅绾㈤槦娴嬭瘯銆?
### P1锛氬叕寮€ CLI Alpha/Beta 鍓嶅畬鎴?
1. 鐢ㄦ埛鏂囨。锛? 鍒嗛挓瀹夎銆侀厤缃€佸懡浠ゆ墜鍐屻€佹潈闄愭ā鍨嬨€佹晠闅滄帓鏌ャ€侀殣绉佽鏄庛€佽縼绉昏鏄庛€?2. 鎬ц兘鍩虹嚎锛氬喎鍚姩銆佺储寮曘€佸父瑙佸伐鍏枫€侀暱浼氳瘽銆佸 Agent token/鏃堕棿棰勭畻銆?3. 鐪熷疄 dogfood锛氳嚦灏?100 杞璇濆拰 20 涓彲閲嶅浠诲姟锛屽け璐ュ繀椤绘矇娣€涓哄洖褰掔敤渚嬨€?4. 瀹夎鐭╅樀锛歅yPI wheel銆乶pm wrapper銆乄indows PowerShell銆乵acOS/Linux shell銆?5. 鐗堟湰銆佹洿鏂版鏌ャ€丆hangelog 鍜屽彂甯冨洖婊氭祦绋嬨€?
### P2锛欳LI 绋冲畾鍚庤繘鍏?
1. Tauri 妗岄潰绔師鍨嬶紝鍏辩敤 Python Agent Runtime锛屼笉澶嶅埗鏍稿績涓氬姟閫昏緫銆?2. 妗岄潰 UI 浼樺厛瑕嗙洊浼氳瘽銆佽鍒掋€佸伐鍏峰鎵广€乨iff銆佷换鍔＄姸鎬併€佹棩蹇椾笌璁剧疆銆?3. 鍐嶈瘎浼?IDE 鎻掍欢銆佺郴缁熻嚜鍔ㄥ寲鍜屾洿娣卞妯℃€侊紱Web 绔笉鏄綋鍓嶄紭鍏堟柟鍚戙€?
## 涓嬩竴鎵瑰缓璁?
涓嬩竴鎵圭洿鎺ュ疄鏂?P0 鐨?CI + 闅旂瀹夎/棣栨鍚姩 E2E + Doctor 娣卞寲銆傝繖涓夐」鑳芥渶蹇妸
鈥滃綋鍓嶆満鍣ㄤ笂鑳借窇鈥濇彁鍗囦负鈥滄柊鐢ㄦ埛鏈哄櫒涓婂彲閲嶅瀹夎鍜岃瘖鏂€濄€?
## Ship Gate 鎵弿缁撹

妫€娴嬫爤锛歅ython 3.10+ CLI + Node.js npm wrapper + SQLAlchemy + SQLite/PostgreSQL + DeepSeek/OpenAI-compatible LLM銆?鏃?Web 鏈嶅姟鎴栧墠绔紝鍥犳 HTTPS銆丆ORS銆丆SRF銆乄eb Auth 鍜?FE 妫€鏌ュ綋鍓嶄笉閫傜敤銆?
| 绫诲埆 | 鑷姩鎵弿缁撹 |
|---|---|
| Security | `.env` 宸插拷鐣ャ€佹湭琚?Git 璺熻釜涓旀棤鏂板鍘嗗彶锛涙湭鍙戠幇纭紪鐮佸瘑閽ユā寮?|
| Database | 鏈彂鐜?SQL f-string 娉ㄥ叆妯″紡锛汼QLAlchemy 浼氳瘽鍖呭惈 rollback锛涜縼绉荤増鏈簱浠嶄笉瀹屾暣 |
| Code | pytest/Ruff/compileall 閫氳繃锛涙牴鐩綍鑴忔枃浠跺拰宸ㄥぇ鏈彁浜ゅ伐浣滄爲浠嶆槸楂橀闄?|
| Dependencies | npm audit 0 婕忔礊锛汸ython 灏氭棤閿佹枃浠跺拰 pip-audit 闂ㄧ |
| AI/LLM | 宸叉湁娉ㄥ叆妫€娴嬨€佹棩蹇楄劚鏁忋€佸伐鍏锋潈闄愶紱MCP 杈撳叆楠岃瘉鍜屾晱鎰熸暟鎹鍙戝悓鎰忛渶缁х画浜哄伐/绾㈤槦纭 |
| Deploy | wheel 鍙瀯寤猴紱灏氭棤 CI銆侀殧绂诲畨瑁呯煩闃点€佹寮忓洖婊氭祦绋?|
| Frontend | SKIP锛屽綋鍓嶄骇鍝佷负 CLI |
| Observability | 鏈夋湰鍦扮粨鏋勫寲閿欒涓庤劚鏁忥紱鏃犲憡璀︺€佷繚鐣欑瓥鐣ュ拰鎬ц兘鍩虹嚎 |

闂ㄧ鍒ゅ畾锛?*DO NOT SHIP publicly**銆傝嚜鍔ㄦ壂鎻忔病鏈夊彂鐜板凡纭鐨?critical secret/SQL injection锛?浣?CI銆丳ython 渚涘簲閾鹃攣瀹氥€侀殧绂诲畨瑁呫€佹暟鎹簱澶囦唤鎭㈠銆丮CP/鏉冮檺绾㈤槦銆佹棩蹇椾繚鐣欏拰鍙戝竷鍥炴粴灏氭湭瀹屾垚銆?褰撳墠鍙€傚悎浣滀负鍐呴儴 Alpha 缁х画 dogfood銆?
## P0 浜у搧鍖栨壒娆?2锛欳I銆侀鍚殧绂讳笌 Doctor

瀹屾垚鏃ユ湡锛?026-06-18

- 鏂板 GitHub Actions锛歐indows/Linux 脳 Python 3.10/3.11/3.12锛屾墽琛?Ruff銆乧ompileall銆乸ytest銆?- 鏂板 package-smoke锛氭瀯寤?sdist/wheel銆佹牎楠?wheel 鍐呭銆乶pm ci/test/pack銆佷笂浼犳瀯寤轰骇鐗┿€?- 鏂板 `dev` 鍙€変緷璧栫粍锛孋I 涓嶅啀渚濊禆寮€鍙戞満棰勮 pytest/Ruff/build銆?- Onboarding 鏀逛负鍐欏叆 `~/.arforge/.env`锛屼笉鍐嶆妸 API Key 鍐欒繘鐢ㄦ埛椤圭洰銆?- 闈?TTY 鍚姩榛樿鎷掔粷宸ヤ綔鍖轰俊浠伙紱鑷姩鍖栧繀椤绘樉寮忚缃?`ARFORGE_TRUST_WORKSPACE=1`銆?- 閰嶇疆鍔犺浇绉婚櫎鏃犺矾寰?`load_dotenv()`锛岄槻姝粠璋冪敤鏍堥檮杩戣璇诲叾浠栭」鐩殑瀵嗛挜銆?- Doctor 鏂板蹇呴渶渚濊禆銆佸寘鐗堟湰涓€鑷存€с€佺鐩樼┖闂淬€佹暟鎹簱閰嶇疆妫€鏌ャ€?- 淇 wheel 鍖呭彂鐜帮細鎺掗櫎 `arforge_corrupt_backup_*`锛屽苟鍦?CI 妫€鏌ョ姝㈠浠姐€乸yc銆佺紦瀛樿繘鍏ュ寘銆?- 鏇存柊 setuptools SPDX license 鍐欐硶锛屾秷闄ゆ瀯寤哄純鐢ㄨ鍛娿€?
楠屾敹璇佹嵁锛歚598 passed`銆丷uff clean銆乧ompileall OK锛涘共鍑€铏氭嫙鐜浠?wheel 瀹夎鎴愬姛锛?wheel 鍏?457 椤逛笖 forbidden=0锛涚┖ HOME/绌哄伐浣滃尯 Doctor 姝ｇ‘鏄剧ず API Key 鏈厤缃€?
## P0 浜у搧鍖栨壒娆?3锛氬畨鍏ㄨ竟鐣屻€佹暟鎹簱鎭㈠涓庡彂琛屽叆鍙?
瀹屾垚鏃ユ湡锛?026-06-18

- ToolRegistry 缁熶竴鎵ц `requires_confirmation`锛岄潪浜や簰鐜 fail-closed锛屾壒鍑嗕綔鐢ㄥ煙閬垮厤閲嶅纭銆?- 缁撴瀯鍖栨棩蹇楀 Authorization銆佷护鐗屻€佹暟鎹簱 URL銆丄WS access key 鍜屽祵濂楁暟鎹€掑綊鑴辨晱銆?- MCP JSON-RPC 澧炲姞 1 MiB 娑堟伅銆?2 灞傚祵濂椼€佹柟娉曞悕鍜屽搷搴斿皝瑁呮牎楠屻€?- 楂樼疆淇″害鎻愮ず娉ㄥ叆鍦ㄨ鍙栬蹇嗐€佸涔犱笂涓嬫枃鍜岃皟鐢ㄦā鍨嬪墠闃绘柇銆?- 鏂板 PostgreSQL `db-backup`銆乣db-verify` 涓庨珮椋庨櫓纭淇濇姢鐨勬仮澶?API锛涚湡瀹炲彧璇诲浠藉拰绂荤嚎楠岃瘉鎴愬姛銆?- 鍗曞厓娴嬭瘯鍏ㄥ眬寮哄埗鍐呭瓨鏁版嵁搴撳苟閲婃斁寮曟搸锛岀姝㈡湰鏈?`.env` 姹℃煋娴嬭瘯鎴栬杩炵湡瀹?PostgreSQL銆?- 琛ラ綈 `python -m arforge` 妯″潡鍏ュ彛锛屽苟鍦ㄩ殧绂诲畨瑁呬腑楠岃瘉銆?
楠屾敹璇佹嵁锛歚611 passed`銆丷uff clean銆乧ompileall OK锛涘畨鍏ㄥ畾鍚戝洖褰?`85 passed`锛?wheel 闅旂瀹夎鎴愬姛锛屽叡 459 椤逛笖 forbidden=0锛沗python -m arforge --version` 鎴愬姛銆?
鏈壒娆″彂鐜板紑鍙戣剼鏈浘鍖呭惈 PostgreSQL 鏄庢枃鍑嵁锛屾簮鐮佸凡绉婚櫎锛屼絾鍑嵁杞崲銆佽繙绔巻鍙插璁″拰鐙珛涓存椂搴撶湡瀹炴仮澶嶄粛鏄汉宸ヤ笂绾块樆鏂」銆傝瑙?`docs/SECURITY_REVIEW_2026-06-18.md`銆?
## P0 浜у搧鍖栨壒娆?4锛氭湰鍦伴殣绉佹暟鎹敓鍛藉懆鏈?
瀹屾垚鏃ユ湡锛?026-06-18

- `arforge privacy` 灞曠ず褰撳墠閰嶇疆鐩綍鐨勬枃浠舵暟銆佸崰鐢ㄥ閲忓拰鍑嵁鏂囦欢鏄惁瀛樺湪锛屼笉璇诲彇鏂囦欢鍐呭銆?- 鏂板 `arforge logs-prune [days]`锛岄粯璁ゆ竻鐞?30 澶╀互鍓嶇殑鏈湴鏃ュ織銆?- 鏂板 `arforge clear-data --dry-run`锛屽彲鍦ㄤ笉淇敼鏁版嵁鐨勬儏鍐典笅棰勮鍒犻櫎鑼冨洿銆?- 瀹為檯鍒犻櫎蹇呴』閫氳繃 high-risk 纭锛涢潪 TTY 榛樿鎷掔粷锛涘嚟鎹?`.env` 榛樿淇濈暀锛屽彧鏈夋樉寮?`--include-credentials` 鎵嶈繘鍏ュ垹闄よ寖鍥淬€?- 闅愮鍚屾剰銆佹棫鐗堣縼绉诲拰闅愮娓呭崟缁熶竴灏婇噸 `ARFORGE_HOME`锛岄殧绂昏繍琛屼笉鍐嶈鍙栫湡瀹炵敤鎴烽厤缃€?
楠屾敹璇佹嵁锛氭柊澧為殣绉佺敓鍛藉懆鏈熷拰闅旂鍥炲綊锛涘叏閲?`619 passed`銆丷uff clean銆乧ompileall OK锛涗复鏃剁敤鎴风洰褰?CLI dry-run 楠岃瘉鏃犳暟鎹鍒犻櫎銆?
渚涘簲閾捐ˉ寮猴細CI 鏂板鐙珛 Python dependency audit 浣滀笟锛屽厛鍗囩骇 pip锛屽啀鎵ц `pip check` 涓?pip-audit锛涢殧绂荤幆澧冨楠岀粨鏋滀负 `No known vulnerabilities found`銆傚紑鍙戜緷璧栫害鏉熷姞鍏?`pip-audit>=2.10.0,<3`銆?
## P0 浜у搧鍖栨壒娆?5锛氫氦浠橀棬绂佷笌 npm 瀹夎閾?
瀹屾垚鏃ユ湡锛?026-06-18

- npm Python 鎺㈡祴銆佸畨瑁呭拰鍚姩鍏ㄩ儴鏀圭敤鍙傛暟鏁扮粍涓?`shell: false`锛屼笉鍐嶈皟鐢ㄨ８ `pip` 鎴栨嫾鎺?shell 鍛戒护銆?- npm lockfile 淇鍏煎鍏ュ彛锛屾纭悓鏃跺彂甯?`arforge`銆?- Windows `install.bat` 鏀逛负鍒涘缓闅旂 `.venv`锛屽苟濮嬬粓浣跨敤 `python -m pip`銆?- npm 浜х墿鏀圭敤 Python 婧愮爜鐧藉悕鍗曪紱CI 瀵?tarball 寮哄埗妫€鏌?pyc銆佺紦瀛樸€佹暟鎹簱涓庡嚟鎹枃浠躲€?- 鏂板瀹屾暣 Changelog銆佸畨鍏ㄧ瓥鐣ャ€佸彂甯?鍥炴粴鎵嬪唽鍜?Ship Gate 鎶ュ憡銆?- 璁板繂涓庡涔犳暟鎹啓鍏ュ墠瀹屾暣鑴辨晱锛涙柊澧?`secrets-scan [path]`锛屽彧鎶ュ憡鏂囦欢銆佺被鍒拰鏁伴噺銆?
楠屾敹璇佹嵁锛氬叏閲?`623 passed`锛汻uff/compileall/npm test/npm audit 閫氳繃锛泈heel 459 entries / forbidden=0锛沶pm tarball 浠?919 椤归檷鑷?463 椤广€乫orbidden=0锛涚湡瀹?npm tarball postinstall 鍦ㄤ竴娆℃€ц櫄鎷熺幆澧冨畨瑁呭苟鎴愬姛瀵煎叆 Arforge 0.7.0銆?
褰撳墠浠嶄负 DO NOT SHIP锛氭棫 PostgreSQL 鍑嵁杞崲銆乣data/memory.db` 涓竴涓嚟鎹牱寮忓彂鐜般€佷复鏃舵暟鎹簱鐪熷疄鎭㈠銆?31 椤硅剰宸ヤ綔鏍戝拰 4 涓紓甯告牴鏂囦欢灏氶渶浜哄伐澶勭疆銆?
## P0 浜у搧鍖栨壒娆?6锛氱増鏈寲鏁版嵁搴撹縼绉?
瀹屾垚鏃ユ湡锛?026-06-18

- Alembic 鎴愪负姝ｅ紡杩愯渚濊禆锛岃縼绉荤幆澧冨拰鐗堟湰鑴氭湰闅?wheel/npm 浜х墿鍙戝竷銆?- `0001_initial` 鍒嗙涓诲簱浜斿紶琛ㄥ拰澶氭櫤鑳戒綋搴撲袱寮犺〃锛屽悇搴撶嫭绔嬭褰曠増鏈€?- 鏂板 `db-sql`銆乣db-migrate`銆乣db-current`銆乣db-stamp`銆乣db-downgrade`銆?- migrate/stamp/downgrade 鍧囨墽琛岄珮椋庨櫓纭锛涢潪 TTY 鏃犳樉寮忔巿鏉冩椂 fail-closed銆?- 鏃㈡湁 Alpha 鏁版嵁搴撳彧鏈夊湪蹇呴渶琛?鍒楀吋瀹规鏌ラ€氳繃鍚庢墠鑳?stamp锛岄伩鍏嶇洸鐩爣璁扮増鏈€?- 绉婚櫎鍖呭鍏ユ椂鑷姩杩炴帴骞跺缓琛ㄧ殑鍓綔鐢紱鏄惧紡鍏煎鍒濆鍖?API 浠嶄繚鐣欍€?- 鏂板鏁版嵁搴撹縼绉讳笌鍥炴粴鎵嬪唽锛屽苟楠岃瘉绂荤嚎 SQL銆佸崌绾с€乻tamp 鍜?disposable downgrade銆?
楠屾敹璇佹嵁锛氬叏閲?`630 passed`锛汻uff/compileall/npm test/npm audit 閫氳繃锛涗富搴?澶氭櫤鑳戒綋 SQLite 闅旂杩佺Щ鍧囧埌 `0001_initial`锛涚绾夸富搴?SQL 涓嶅寘鍚鏅鸿兘浣撹〃锛泈heel 464 entries銆乶pm 468 entries锛岃縼绉昏祫浜х己澶卞潎涓?0銆?
## P0 浜у搧鍖栨壒娆?7锛氭€ц兘鍩虹嚎涓庣绾?Dogfood

瀹屾垚鏃ユ湡锛?026-06-18

- 閲嶅缓鎹熷潖鐨?dogfood 鑴氭湰锛屽舰鎴愰殧绂?profile銆丼QLite 鍜屾棤缃戠粶妯″瀷鏇胯韩鐨勭‘瀹氭€ч獙鏀躲€?- 100 杞畬鏁?chat/reasoning/memory/learning 娴佺▼闆跺け璐ワ紝骞堕澶栭獙璇佸伐鍏枫€丮CP 鍜屾寔涔呭寲鑴辨晱銆?- 鏂板鐙珛鍐疯繘绋嬫€ц兘宸ュ叿鍙?CI budget job銆?- cProfile 瀹氫綅 SQLAlchemy/璁板繂灞?eager import锛涙敼涓烘寜闇€瀵煎叆鍚?Agent init P50 浠?614.5ms 闄嶈嚦 85.1ms銆?- 妯″瀷閫熺巼闄愬埗绉诲姩鍒伴€傞厤鍣ㄥ伐鍘傦紝瑕嗙洊 chat銆乻tream銆乸lanning 涓?multi-agent 鐨勭湡瀹?provider 璋冪敤銆?
楠屾敹璇佹嵁锛氬叏閲?`633 passed`锛?00-turn dogfood 0 failures / 0 network calls / P95 14.01ms锛涗簲椤瑰喎鍚姩棰勭畻鍏ㄩ儴閫氳繃锛汻uff/compileall/npm test/npm audit 閫氳繃銆?
## P0 浜у搧鍖栨壒娆?8锛氱敤鎴锋枃妗ｄ笌寮€鍙戣€呬氦鎺?
瀹屾垚鏃ユ湡锛?026-06-18

- 閲嶅啓浜у搧 README锛岀Щ闄よ繃鏃剁殑瀛楄妭鐮佹仮澶嶆灦鏋勫０鏄庯紝琛ラ綈鐪熷疄瀹夎銆丳ostgreSQL 鍒濆鍖栥€佽縼绉汇€佹潈闄愩€侀殣绉併€佸浠姐€佹帓闅滃拰鍙戝竷闂ㄦ銆?- 鏂板 `.env.example`銆佺敤鎴锋寚鍗楀拰寮€鍙戣€呬笂鎵嬫寚鍗楋紝骞剁敤鏂囨。濂戠害妫€鏌ュ懡浠よ鐩栥€侀摼鎺ユ湁鏁堟€у拰绀轰緥鍑嵁瀹夊叏鎬с€?- 浠ラ殧绂绘柊鐢ㄦ埛璺緞瀹炴祴鏃跺彂鐜?`ARFORGE_HOME` 鍙閮ㄥ垎妯″潡灏婇噸锛涚幇宸茬粺涓€瑕嗙洊閰嶇疆鍔犺浇銆乷nboarding銆丏octor 鍜岄粯璁ゅ浠界洰褰曘€?- 婧愮爜鍖呬粠鏍圭洰褰?Python 閫氶厤绗︽敼涓烘樉寮忕櫧鍚嶅崟锛屾帓闄や笉鍙墽琛岀殑鍘嗗彶 `verify_modules.py`锛泈heel 涓?sdist 鍧囨棤宸茬煡绂佸叆椤广€?
楠屾敹璇佹嵁锛氬叏閲?`640 passed`锛汻uff 浜у搧鑼冨洿銆乧ompileall銆乶pm test銆乶pm audit 鍧囬€氳繃锛泈heel/sdist 鏋勫缓鎴愬姛锛涢殧绂?Doctor 浠呭啓鍏ヤ复鏃?profile锛涙枃妗ｄ笌浜ゆ帴瀹氬悜鍥炲綊 `29 passed`銆?
## P0 浜у搧鍖栨壒娆?9锛氬彲澶嶇幇渚涘簲閾句笌杩愯鎬侀殧绂?
瀹屾垚鏃ユ湡锛?026-06-18

- 鏂板浠?Python 3.10 鏈€浣庢敮鎸佺増鏈В鏋愮殑璺ㄥ钩鍙?SHA-256 閿佹枃浠讹紝CI 浣跨敤 `--require-hashes` 瀹夎寮€鍙戜緷璧栵紝鍙戝竷瀹¤浣跨敤鐙珛杩愯鏃堕攣銆?- 鏂板鍙戝竷璇佹嵁鐢熸垚鍣細浜у嚭 CycloneDX 1.6 SBOM銆乣SHA256SUMS` 鍜屾満鍣ㄥ彲璇?release manifest锛涙牎楠屽櫒浼氭嫆缁濈鏀广€佽矾寰勭┛瓒婂拰缂哄け浜х墿锛孋I 鍙戝竷璇佹嵁瑕佹眰骞插噣 Git 鏍戙€?- 缁熶竴 `ARFORGE_HOME` 涓烘棩蹇椼€佷换鍔°€佷俊浠汇€佽瑷€銆佸畨鍏ㄥ浠藉拰鏃ф暟鎹簱璺緞鐨勫崟涓€鏉冨▉锛涘鍏ュ寘涓嶅啀鍒涘缓鐪熷疄鐢ㄦ埛鐩綍銆?- 鏃ュ織鏀逛负杩藉姞寮?JSON Lines锛屽寘鍚?UTC 鏃堕棿銆佷簨浠?ID銆佽繘绋?ID鍜岄€掑綊鑴辨晱涓婁笅鏂囷紝閬垮厤闅忔枃浠跺闀垮弽澶嶆暣鏂囦欢閲嶅啓銆?
楠屾敹璇佹嵁锛氬叏閲?`649 passed`锛汻uff/compileall/npm test/npm audit 鍏ㄩ€氳繃锛沺ip-audit 瀵瑰彂甯冮攣鎶ュ憡鏃犲凡鐭ユ紡娲烇紱SBOM 瑕嗙洊閿佷腑鐨勫叏閮ㄧ粍浠讹紱Python 3.11/3.12 闅旂 wheel 瀹夎閫氳繃锛孋I 缁х画璐熻矗 3.10鈥?.12 脳 Windows/Linux 瀹屾暣鐭╅樀銆?
## P0 浜у搧鍖栨壒娆?10锛氱晫闈笌鍚庣鍔熻兘濂戠害

瀹屾垚鏃ユ湡锛?026-06-18

- Node 鍖呰灞備笉鍐嶇淮鎶ゆ畫缂哄府鍔╁拰鐙珛鐗堟湰杈撳嚭锛屾墍鏈夊弬鏁般€乻tdout/stderr 涓庨€€鍑虹爜瀹屾暣濮旀墭 Python 鍚庣銆?- npm postinstall 鐜板湪鐪熷疄鍒涘缓鍖呭唴 `.venv`锛汸ython 鐗堟湰涓嶈冻銆佽櫄鎷熺幆澧冩垨鍚庣瀹夎澶辫触鏃?fail-closed锛屼笉鍐嶅畨瑁呭嚭涓€涓棤娉曡繍琛岀殑鍛戒护銆?- 淇 `main.py` 涓㈠純鍚庣杩斿洖鐮併€佹樉寮?`arforge chat` 澶勭悊鍣ㄧ鍚嶉敊璇€佸懡浠ゅ悗 `--verbose/--no-stream` 琚拷鐣ュ拰澶氫綑鍙傛暟琚潤榛樻帴鍙椼€?- 澶嶆潅瀵硅瘽鎺ュ叆鐪熷疄 MasterAgent 绠＄嚎锛涢珮缃俊鎻愮ず娉ㄥ叆鍦?orchestration/妯″瀷鍓嶉樆鏂€?- 宸ュ叿鍖归厤鍚庡け璐ヤ細鏄庣‘灞曠ず骞跺仠姝㈠綋鍓嶈疆锛屼笉鍐嶈惤鍥炴ā鍨嬬敓鎴愨€滄浛浠ｆ垚鍔熺瓟妗堚€濄€?- 鏁版嵁搴撳睍绀洪殣钘忕敤鎴蜂笌瀵嗙爜锛涘鏅鸿兘浣撴暟鎹簱 URL 浣跨敤缁撴瀯鍖?URL 鎺ㄥ锛屼慨澶?`rstrip` 璇垹璺緞瀛楃銆?- 鏃?profile 杩佺Щ鏀逛负涓存椂鏂囦欢銆佹祦寮?SHA-256 鏍￠獙銆佸師瀛愭浛鎹㈠拰鍑嵁鏉冮檺鏀剁揣锛涗换涓€鏂囦欢澶辫触浣?CLI 杩斿洖闈為浂銆?- 鏂板 `docs/FEATURE_CONTRACT.md`锛屾槑纭?CLI/npm 宸插疄鐜帮紝Desktop/Web/IDE 灏氭湭瀹炵幇锛屼笉鎶婄焊闈㈣鍒掑啋鍏呬氦浠樺姛鑳姐€?
楠屾敹璇佹嵁锛氬叏閲?`666 passed`锛汻uff/compileall/npm test/npm audit 閫氳繃锛涚湡瀹?npm tarball postinstall 鎴愬姛鍒涘缓绉佹湁 `.venv`锛屽畬鏁村府鍔╁寘鍚暟鎹簱鍛戒护锛屾湭鐭ュ懡浠ら€€鍑虹爜涓?2銆?# P0 浜у搧鍖栨壒娆?12 鈥?Machine Bridge 1.1 浼氳瘽涓庝簨浠跺熀纭€锛?026-06-21锛?
## 宸插畬鎴?
1. 淇濈暀鍗忚 1.0 鍙鍏煎锛屾柊澧炴樉寮忓崗鍟嗙殑 1.1 浼氳瘽鎺ュ彛銆?2. 鏂板 session create/get/close銆乧hat start/cancel 鍜?operation get銆?3. chat 璇锋眰鍏堣繑鍥?accepted锛岄殢鍚庡悗鍙板彂閫佸甫 session_id銆乷peration_id銆佽繛缁?sequence 鍜?UTC timestamp 鐨勪簨浠躲€?4. 鍗曚細璇濆彧鍏佽涓€涓椿鍔ㄦ搷浣滐紱榛樿闄愬埗 32 涓椿鍔ㄤ細璇濄€? 涓苟鍙戞搷浣溿€?00000 瀛楃杈撳叆鍜?1鈥?00 绉掕秴鏃躲€?5. 杈撳嚭閲囩敤闃诲鍐欒儗鍘嬶紝涓嶅缓绔嬫棤鐣屼簨浠堕槦鍒楋紱缁堟€佸巻鍙叉湁涓婇檺骞跺彲鍥炴敹銆?6. 娴佸紡鑱婂ぉ琛ラ綈妯″瀷/璁板繂鍓嶇殑楂樼疆淇℃彁绀烘敞鍏ラ樆鏂紱妯″瀷寮傚父鎴愪负 operation.failed锛屼笉鍐嶄綔涓烘垚鍔熷洖绛旀枃鏈€?
## 楠屾敹

- Bridge/stream 瀹氬悜涓庣浉鍏冲绾︼細42 passed銆?- 鍏ㄩ噺娴嬭瘯锛?88 passed / 0 failed锛?00.34s锛夈€?- Ruff 浜у搧鑼冨洿銆乧ompileall銆乶pm test銆乶pm audit锛氶€氳繃銆?- 鐪熷疄瀛愯繘绋嬪崗璁儫娴嬶細1.1 鍗忓晢銆佸缓浼氳瘽銆乧hat accepted銆佹湁搴忎簨浠躲€佺粓鎬併€佸叧闂細璇濆拰杩涚▼閫€鍑哄叏閮ㄩ€氳繃銆?
## 鏈畬鎴愯竟鐣?
- 鍙栨秷/瓒呮椂鍦ㄤ簨浠惰竟鐣屽崗浣滅敓鏁堬紱鍗℃鐨勪緵搴斿晢璋冪敤浠嶄緷璧?provider HTTP timeout銆?- 浼氳瘽灏氭湭璺ㄨ繘绋嬫寔涔呭寲銆?- 宸ュ叿瀹℃壒銆乨iff銆佷换鍔°€佹棩蹇椾笌璁剧疆浠嶆湭寮€鏀炬満鍣ㄥ啓鎺ュ彛銆?# P0 浜у搧鍖栨壒娆?13 鈥?宸ュ叿瀹℃壒涓?Diff 鐘舵€佹満锛?026-06-21锛?
## 宸插畬鎴?
1. 鏂板 ActionRuntime锛屽鎵圭敱鍚庣鍒涘缓锛岀粦瀹?session銆佸姩浣滅被鍨嬪拰 subject锛屽叿鏈?TTL 涓斿彧鑳芥秷璐逛竴娆°€?2. 宸ュ叿 prepare 楠岃瘉鐪熷疄娉ㄥ唽琛ㄣ€佸弬鏁?schema銆佺被鍨嬨€佸ぇ灏忓拰 critical 椋庨櫓锛涙湭缁忔壒鍑嗐€佹嫆缁濄€佽繃鏈熸垨閲嶆斁鍧囦笉鎵ц銆?3. Diff preview 鍙帴鍙楀伐浣滃尯鐩稿璺緞锛屾嫆缁濋€冮€搞€佺粷瀵硅矾寰勩€乣.git`銆乣.venv`銆佷簩杩涘埗鍜岃秴闄愬唴瀹广€?4. Diff apply 鍦ㄥ啓鍏ュ墠澶嶆牳鍘熷唴瀹?SHA-256 涓?Python 璇硶锛屽苟浣跨敤鍘熷瓙鍐欏叆锛涘閮ㄤ慨鏀逛骇鐢?DIFF_CONFLICT銆?5. Rollback 浣跨敤绗簩娆＄嫭绔嬪鎵癸紝骞跺鏍稿綋鍓嶆枃浠朵粛绛変簬宸插簲鐢ㄥ搱甯岋紱鏂版枃浠跺洖婊氫細瀹夊叏鍒犻櫎銆?6. 鏈喅 diff銆乸repared tool 鎴?pending approval 瀛樺湪鏃讹紝浼氳瘽鍏抽棴澶辫触锛岄伩鍏嶉仐鐣欏鍎挎巿鏉冦€?7. 鎵€鏈?action 鍝嶅簲鍏堜簬鍏朵簨浠讹紱鏃ュ織鍙褰?ID銆佸姩浣滃拰鐘舵€侊紝涓嶈褰曞唴瀹规垨宸ュ叿鍙傛暟銆?
## 楠屾敹

- R2/瀹夊叏/Bridge 瀹氬悜鍥炲綊锛?6 passed銆?- 鍏ㄩ噺娴嬭瘯锛?10 passed / 0 failed锛?29.42s锛夈€?- Ruff 浜у搧鑼冨洿銆乧ompileall锛氶€氳繃銆?- 鐪熷疄瀛愯繘绋嬶細diff 瀹屾暣搴旂敤/鍥炴粴銆佸伐鍏峰鎵规墽琛屻€佸搷搴?浜嬩欢椤哄簭鍜?exit 0 鍏ㄩ儴閫氳繃銆?
## 鏈畬鎴愯竟鐣?
- 宸ュ叿鎵ц鐩墠涓哄悓姝ヨ姹傦紝灏氭湭褰㈡垚鍙彇娑堢殑鍚庡彴 task銆?- 瀹℃壒涓?diff 鐘舵€佸綋鍓嶄粎鍦ㄨ繘绋嬪唴锛岄噸鍚仮澶嶅皻鏈疄鐜般€?- 浠诲姟銆佹棩蹇楁煡璇㈠拰璁剧疆鐘舵€佹満灏氭湭鎺ュ叆 Bridge銆?
