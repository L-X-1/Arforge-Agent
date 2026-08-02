# Arforge Agent 瀹夊叏瀹℃煡

鏃ユ湡锛?026-06-18
鑼冨洿锛歅ython CLI銆佸伐鍏锋墽琛屻€丮CP銆佹棩蹇椾笌闅愮銆丳ostgreSQL 澶囦唤鎭㈠銆?
## 鎵ц鎽樿

鏈疆鍙戠幇骞朵慨澶嶄簡涓ぎ宸ュ叿纭鏈墽琛屻€佺粨鏋勫寲鏃ュ織娉勫瘑銆丮CP 鏃犺緭鍏ヨ竟鐣屻€亀heel 娣峰叆澶囦唤銆?閰嶇疆璺ㄧ洰褰曡鍙栧瘑閽ョ瓑闂銆傚綋鍓嶈嚜鍔ㄥ寲瀹夊叏鍥炲綊閫氳繃锛屼絾鏇惧嚭鐜板湪寮€鍙戣剼鏈腑鐨?PostgreSQL
鍑嵁蹇呴』鐢辩淮鎶よ€呭湪鏁版嵁搴撶杞崲锛涜繖鏄氦鎺ュ墠鐨勪汉宸ラ樆鏂」銆?
## Critical

### SEC-001锛氭暟鎹簱鍑嵁鏇句互鏄庢枃瀛樺湪浜庡紑鍙戣剼鏈?
褰卞搷锛氳幏寰楀伐浣滃尯鎴栧巻鍙插壇鏈殑浜哄彲鑳借闂湰鍦?PostgreSQL銆?
鐘舵€侊細婧愮爜宸蹭慨澶嶃€俙scripts/test_pg_connection.py` 鏀圭敤鏍囧噯閰嶇疆鍔犺浇锛?`scripts/setup_postgres.bat` 鍙鍙栬繘绋嬬幆澧冨彉閲忎笖涓嶅啀閲嶇疆鎴栨墦鍗板瘑鐮併€?
鍓╀綑鍔ㄤ綔锛氬湪 PostgreSQL 涓疆鎹㈣璐﹀彿瀵嗙爜锛屾洿鏂扮敤鎴风鏈?`~/.arforge/.env`锛屽苟妫€鏌ヤ换浣曡繙绔?Git 鍘嗗彶鎴栧浠戒腑鏄惁鍑虹幇鏃у€笺€傛鍔ㄤ綔浼氫慨鏀瑰閮ㄦ暟鎹簱鐘舵€侊紝鏈敱鑷姩鍖栨搮鑷墽琛屻€?
### SEC-002锛歍oolRegistry 鏈墽琛?requires_confirmation

褰卞搷锛欰gent 鍙湪娌℃湁涓ぎ纭鐨勬儏鍐典笅璋冪敤澹版槑涓?medium/high 椋庨櫓鐨勫伐鍏枫€?
鐘舵€侊細宸蹭慨澶嶃€備腑澶墽琛屽櫒鐜板湪 fail-closed锛岄潪 TTY 榛樿鎷掔粷锛涜幏鎵逛綔鐢ㄥ煙浣跨敤 ContextVar锛?閬垮厤鏂囦欢鎿嶄綔鍐嶆寮瑰嚭閲嶅纭銆傚疄鐜颁綅浜?`arforge/tool_registry.py` 涓?`arforge/security/file_ops.py`銆?
## High

### SEC-003锛氱粨鏋勫寲鏃ュ織 context 鏈€掑綊鑴辨晱

鐘舵€侊細宸蹭慨澶嶃€侫uthorization銆丄PI Key銆乼oken銆佹暟鎹簱 URL 鍑嵁鍜?AWS access key 鍧囦細鑴辨晱锛?宓屽 dict/list/tuple 閫掑綊澶勭悊銆?
### SEC-004锛歁CP JSON-RPC 鎺ュ彈鏃犵晫鎴栫暩褰㈣緭鍏?
鐘舵€侊細宸蹭慨澶嶃€傞檺鍒舵秷鎭负 1 MiB銆佹渶澶у祵濂?12 灞傘€佹柟娉曞悕 128 瀛楃锛屽苟楠岃瘉 JSON-RPC 鍝嶅簲灏佽銆?
### SEC-005锛氶珮缃俊搴︽彁绀烘敞鍏ヤ粛鍙戦€佺粰妯″瀷

鐘舵€侊細宸蹭慨澶嶃€傛櫘閫氳亰澶╀笌鐩存帴妯″瀷璋冪敤鍛戒腑鐨?high severity 璇锋眰锛屼細鍦ㄨ鍙栬蹇嗐€佹敞鍏ュ涔犱笂涓嬫枃鍜屾ā鍨嬭皟鐢ㄥ墠闃绘柇锛涘崟涓€鍙枒妯″紡缁х画璁板綍骞舵彁绀猴紝鍑忓皯鍚堟硶瀹夊叏璁ㄨ鐨勮鏉€銆?
## Database Recovery

- `arforge db-backup [path]`锛氫娇鐢?pg_dump custom format锛屾棤 shell锛屽瘑鐮佷粎缁?PGPASSWORD 瀛愯繘绋嬬幆澧冧紶閫掋€?- `arforge db-verify <path>`锛氫娇鐢?pg_restore --list 绂荤嚎楠岃瘉鐩綍銆?- `restore_backup()`锛氬繀椤绘樉寮忕洰鏍囨暟鎹簱骞惰繘琛?high-risk 纭銆?- Windows 鑷姩鍙戠幇 PostgreSQL 鏍囧噯瀹夎鐩綍锛屼篃鏀寔 `ARFORGE_PG_BIN`銆?- 鏈疆鐪熷疄鍙婕旂粌锛?0,940 瀛楄妭澶囦唤鎴愬姛锛岀绾跨洰褰曢獙璇佹垚鍔燂紝涓存椂鏂囦欢宸插垹闄ゃ€?
## Remaining Manual Gates

1. 杞崲鏇炬毚闇茬殑 PostgreSQL 鍑嵁銆?2. 鍦ㄧ嫭绔嬩复鏃舵暟鎹簱鎵ц涓€娆＄湡瀹?restore锛屽苟鏍稿琛ㄦ暟涓庡叧閿褰曟暟銆?3. 瀹℃牳杩滅 Git 鍘嗗彶鍜屽閮ㄥ浠芥槸鍚﹀惈鏃у嚟鎹€?4. 寤虹珛 Python 渚濊禆閿佸畾涓庢紡娲炲璁￠棬绂併€?
## Automated Verification

- 瀹夊叏銆丮CP銆佹暟鎹簱銆佸伐鍏锋潈闄愬畾鍚戝洖褰掞細85 passed銆?- 鍏ㄩ噺绂荤嚎鍥炲綊锛?11 passed锛汻uff clean锛沜ompileall OK銆?- 娴嬭瘯鍏ㄥ眬寮哄埗浣跨敤鍐呭瓨鏁版嵁搴擄紝骞跺湪姣忎釜鐢ㄤ緥鍓嶅悗閲婃斁寮曟搸锛岀姝㈠紑鍙戣€?`.env` 璁╁崟鍏冩祴璇曡杩炵湡瀹?PostgreSQL銆?- wheel 闅旂瀹夎涓庢ā鍧楀叆鍙ｉ獙璇佹垚鍔燂細459 entries锛宖orbidden=0锛宍python -m arforge --version` 鍙繍琛屻€?- 闅愮鐢熷懡鍛ㄦ湡鍥炲綊瀹屾垚锛氭暟鎹竻鍗曚笉璇诲彇鍐呭锛沗logs-prune` 鎻愪緵榛樿 30 澶╀繚鐣欙紱`clear-data --dry-run` 鍙瑙堬紝楂橀闄╃‘璁ゅけ璐ユ椂涓嶅垹闄わ紝鍑嵁榛樿淇濈暀銆?- 鎸佷箙鍖栭槻娉勬紡锛氳蹇嗕笌瀛︿範鍐呭钀藉簱鍓嶅畬鏁存浛鎹?API key銆乼oken銆佹暟鎹簱 URL 鍑嵁锛沗secrets-scan` 涓嶅洖鏄剧瀵嗗€笺€傛棦鏈?`data/memory.db` 浠嶆湁涓€涓嚟鎹牱寮忓彂鐜帮紝绛夊緟鐢ㄦ埛鍐冲畾瀹夊叏杩佺Щ鎴栨竻闄ゃ€?- npm 渚涘簲閾撅細瀹夎/鍚姩涓嶅啀缁忚繃 shell锛泃arball 鐧藉悕鍗曢獙璇佷负 463 files / forbidden=0銆?