"""Provider-neutral office artifact tools.

The generated files use the standard OOXML/PDF container formats and only the
Python standard library.  This keeps the tools available in the packaged
desktop sidecar instead of silently depending on an optional desktop suite.
"""

from __future__ import annotations

import base64
import importlib
import io
import json
import math
import re
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

from arforge.tool_registry import ParamSchema, register_tool


_MAX_ROWS = 2_000
_MAX_COLUMNS = 100
_MAX_SLIDES = 100
_MAX_TEXT_CHARS = 400_000


def _file_tools():
    """Resolve file helpers at call time so workspace/module reloads stay scoped."""
    return importlib.import_module("arforge.tools.file_tools")


def _target(filename: str, suffix: str) -> Path:
    raw = str(filename or "").strip()
    if not raw:
        raise ValueError("filename is required")
    candidate = Path(raw)
    if candidate.suffix == "":
        raw += suffix
    elif candidate.suffix.lower() != suffix:
        raise ValueError(f"target must use the {suffix} extension")
    return _file_tools()._resolve(raw, purpose="write")


def _write(path: Path, payload: bytes) -> str:
    file_tools = _file_tools()
    result = file_tools._safe_write_bytes(
        path,
        payload,
        require_confirm=file_tools._write_requires_confirmation(),
    )
    if not result.get("success"):
        raise PermissionError(f"Error writing {path}: {result.get('error', 'unknown')}")
    return f"wrote {path}"


def _json_value(raw: str, label: str):
    if not isinstance(raw, str) or len(raw) > 2_000_000:
        raise ValueError(f"{label} must be a bounded JSON string")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} is not valid JSON: {exc.msg}") from exc


def _column_name(index: int) -> str:
    value = index + 1
    name = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _spreadsheet_rows(data) -> list[list[object]]:
    if not isinstance(data, list):
        raise ValueError("data_json must contain an array")
    if data and all(isinstance(item, dict) for item in data):
        headers: list[str] = []
        for item in data:
            for key in item:
                text = str(key)
                if text not in headers:
                    headers.append(text)
        rows = [headers, *[[item.get(key) for key in headers] for item in data]]
    elif all(isinstance(item, list) for item in data):
        rows = data
    else:
        raise ValueError("data_json must be an array of objects or an array of arrays")
    if len(rows) > _MAX_ROWS or any(len(row) > _MAX_COLUMNS for row in rows):
        raise ValueError(f"spreadsheet is limited to {_MAX_ROWS} rows and {_MAX_COLUMNS} columns")
    return rows


def _xlsx_cell(reference: str, value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return f'<c r="{reference}" t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)):
        return f'<c r="{reference}"><v>{value}</v></c>'
    text = str(value)
    if len(text) > 32_767:
        raise ValueError(f"cell {reference} exceeds the 32767 character limit")
    return f'<c r="{reference}" t="inlineStr"><is><t xml:space="preserve">{escape(text)}</t></is></c>'


def _xlsx_bytes(rows: list[list[object]], sheet_name: str) -> bytes:
    name = str(sheet_name or "Sheet1").strip() or "Sheet1"
    if len(name) > 31 or re.search(r"[\\/*?:\[\]]", name):
        raise ValueError("sheet_name is invalid")
    sheet_rows = []
    for row_index, row in enumerate(rows, 1):
        cells = "".join(
            _xlsx_cell(f"{_column_name(column_index)}{row_index}", value)
            for column_index, value in enumerate(row)
        )
        sheet_rows.append(f'<row r="{row_index}">{cells}</row>')
    sheet_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f"<sheetData>{''.join(sheet_rows)}</sheetData></worksheet>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/worksheets/sheet1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            "</Types>",
        )
        package.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/></Relationships>',
        )
        package.writestr(
            "xl/workbook.xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets><sheet name="{escape(name, {chr(34): "&quot;"})}" sheetId="1" r:id="rId1"/>'
            "</sheets></workbook>",
        )
        package.writestr(
            "xl/_rels/workbook.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            'Target="worksheets/sheet1.xml"/></Relationships>',
        )
        package.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return buffer.getvalue()


@register_tool(
    "write_xlsx",
    "Create a real .xlsx spreadsheet from JSON rows in the active workspace. "
    "Use an array of objects for named columns or an array of arrays for an explicit table.",
    keywords=["xlsx", "spreadsheet", "table workbook", "电子表格", "生成表格"],
    params=[
        ParamSchema("filename", "path", "target .xlsx filename"),
        ParamSchema("data_json", "string", "JSON array of objects or array of arrays"),
        ParamSchema("sheet_name", "string", "worksheet name", required=False, default="Sheet1"),
    ],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def write_xlsx(filename: str, data_json: str, sheet_name: str = "Sheet1") -> str:
    rows = _spreadsheet_rows(_json_value(data_json, "data_json"))
    return _write(_target(filename, ".xlsx"), _xlsx_bytes(rows, sheet_name))


_PML = "http://schemas.openxmlformats.org/presentationml/2006/main"
_DML = "http://schemas.openxmlformats.org/drawingml/2006/main"
_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

# Deterministic, metadata-scrubbed blank OOXML presentation template. It
# contains one valid blank layout and the required master/theme relationships.
# Keeping it embedded makes packaged desktop generation independent of a local
# office suite while still producing files accepted by native applications.
_PPTX_TEMPLATE_B85 = (
    "P)h>@6aWAK2mnBZ^IWbQH$_4L007to000vJ003J<Z*FvDZggK%d2nTOT`qWSY_(L$PQx$|y(94tk*`(bmIENvv<H?GOC{g~hGf!O"
    "c#~&Zn!m?M3JRzYB-)Fm@x0CJWVSInSz{pOY$nF(NF-=;S17y4#Pie5@LVLsU<=UBVkRmiF`FJAO`a-`lti|rOe~rGg_M*p(Ez2+"
    "qm7-?1p^$*u#g_|S6HAt8I4Y5?kuC_A=esWI=R9UR+^LRO`L9%1k@yw%NAIBWdgj{DhG~zxwgeOm*LhSjm!o^OXX=00YdI{s5?I!"
    "Y<UlHYl12;nM2@vFcBraXXyh{<TcpzccmRsU0JFe3zx4<q@-Ojqra4?0c8h0VMxcxJ0On7*e%BUPS(-x%TzPx!Ff8w?li)E3DyeV"
    "4wB$gxGw?6*MRN#|D$MRdL7|K<0DrZ_rB_m^q=nIEmUsB)Gf{qavxjmk4&=pm!|JfO9KQH0000806>NFTsgcluGjzo0KWkM01E&B"
    "0AF%tY;!Lza%F6DrI1Za12GVW?}Gm!%-x-B4<gcRFCz3-r2c?0naxHwA0*Ra|Gm+Jy3m8*apryJ;bAu0_b{sym+Dj0u<CkH98I!5"
    "It|Z<$D2D)RVZ4TQ)CTiuCN`huQpFSleD8c`CL__#HwKu$@hrWOdP0oDRXSem`WgNV{w?typdyE_x&xF-wYTQOtrHb%FeDq9nP8m"
    "$Hu@ymV{8IV|a<==Z2-?STxvV_9eB_ch<dTc7T_KR(}^t<LC`PBy$WL<&xL3@#B=UU@lzS@~ho7@~03k-adQ)P)h>@6aWAK2mnBZ"
    "^ITq*<|Ft3002t^0018V003}sbT40WWo&aVaB^jHWo~p~bZKvHE_iKhE^=jTbFGulO2jY_hwp;#5aw>vu742ObT1<8K@hDE5SwWm"
    "Op}m_t9^STLTzO!d+2d~nfc~pAluznZ`c6?X=eo#Sq=<s?Uc5yfY<8b;uaW1X_Yk2qJRMjcIElm_8E<gX^1-Qi6x390bPv#j&rIz"
    ">?LK+qfIZ33%!h~3@!JvewQusO`hNIFl9hFW3s&x5ccX4ST%S&h3%R~*Ld&hj~;D2vVtEpem(`4ma$5P7NdYM$`TFuaf!{E5<VdP"
    "lNh5ViDFF&GFsuIq=?~9V-n6fiY2Y<HMOFAGx!n*gOlq_!X=TbRYlS)P85F1-*7wzpM8Py8&FFF1QY-O00;m;h4Wmab*FC?0ssJ1"
    "3;+NW0001RaC9$la%FR6ZggREX>V>Wcx`O$m)nloFc60CEA<^L-&SnMfg~W3mAVyDC0e0{K7cnFAX>+XY(s&k?>IOKu&T5Vkh_fM"
    "_Z+^lENA|FDmgiVR7E8c>OPGr0g+XCA$AG<vssK{N|a_IXS@=S&@(9doPPZ>uV=Lc1wu28TM32{YQ_?}*SelLj>`5>GWAr|Akeq1"
    "WXUv|a_8id{l)Mlcf9d9bV^nTYWK^}?60=lB7+}Qb|^9ZHHZY>)S>o8t=eeyXQJJ9abJ>RM_3=;6zD}Iv_d*G#kLjCe=(&&{>+z3"
    "Kdg`<PpIbxQ4srKfb8VVtf0rGPC9q~vweLb*$ESP?i35a8D!^#hVdjehGRsc(x9xYbu_A}8w8yyhb=pBy@8Wn>obRR&dl0sCGFSi"
    "N)pb@Y%lxK%kQS9TM0jMw?<9L<T9a{g7F=m3r-1YHtcPEX)|JLnl}<)OYvR48$QHLL0A)AdrXC+UL8cHul%|y6h?Am6XzYIIeOT5"
    "<5v|g@<qXUW0=9g3zy``Fq=NPw&Xiila=UmjqPW6NWYb0#I;ef8L$Tju&X0e4~|UrI9?47r{iJKcs-h65}ASrJ`EJh$M5;H5C%Se"
    "&nM{lxPIh@1E7|Q1vI$<6nk+z0BWgNKw%Ha^Wtzk0BWgNK+z4LDDa0nx}#zN#XTTHXSk$0Di+Z622ePOhD*Am(!5_kJ~5s9UxD-="
    "P)h>@6aWAK2mnBZ^IU{j6v*!f000p+001EX003}sbT4ykX=G(hVRLk4a&s?pY-wa=O<{9%WpXhtcx`O$TWf3N)*1d@=zkd0k3}n;"
    "i*9DeVWb%)3(m%@H$UK5qw%QLNb1oU$KJ58g}`<pO9-?{Xae1Yr2UeTPbKX(?T=YvJNXxVbvYy19y_*^fw37DtfN=w@}Bp3pXXeL"
    "z5Ck!B<}2mJde_(tDrl&(g~9w9Y)DcS9$xPui8o{7c3dFI8DN?auDXqYwN%M)!l3@kB4uvT!g#>eI)rB>ndX*vNcW1gK;=v`JFTi"
    "6Zket`Gg60<vZGtvv;8HNvvUAH?;|i5~Xg>FVj99jiMmzr@?d*CZg(uhcOf2e?E?~T=te-rniiTIdoIDKH<_j%rDrAhsASyr~3OK"
    "9Cf1MK14~^5!7I7WzV4(^UfZNyUO+sQndBET3xv=6^--kArHf%l<d9Ev#o5Cmm}QY+vLzEbg6U_Hi7sS9h4vHYFgE(ENG{i@5mxs"
    "+aK{s@r3Ynz(YXsp!lm5ws2o`g31^))?obBoVvkyFsHUA2hduB7PG3HJ3AdLr*rh;>5pH0a`^nk_y2u<{Po{DRouX%ja*3IrabB@"
    "@A^J=je$>9A4)3KU8=eR>Zm>@_5fSHhl%;PXpPLZfQKby_l7d{ka-5~NfhujPe<ZTkWT8nk?99WBU&e4;qSZDp~S_=RDF|x3trDx"
    "4aY&MZ4qqyzDEpfJg!3lKFeo03$31c9RdkSo^7PTZr({!fUH1RlT~HBlDbhg?udg7q9q~`hl)hH_^7qxo6iT^CN?B)i6Su#gpHH1"
    "Bi%rTsn>WSf(^qYCs1W;8PCP*VLIs)g|5QGK$JkSJ(yutRaPl|%4?6rzMBpYikjQ-1n@ygp#3=IkCaY)FUh-#gD8cuMfpMv3&RU<"
    "f7w3qMZ{hjm)XaX0Q%`Ff#9Vt3GlWz73nCdJ*tK*KE=7%5(jZu&O0mqlx7YN#jFsrM`P8y4_(G$qkIn&_3f=HOk(};`JWG;{^#f)"
    "Umkw>-tl)I{qVmJkG^?+{Opfa?jF7P_VBw8it#Gcc@>Q^408IK<ih!kATvgM^z`VnuNy|-C1r$T`v@TEtH`B9MV@Y|ealCxXZDa|"
    ">%LB1Z}E&MFji{S{W-)yHa5(QnL&wx2(g!+8CNDlR`6gio{9V~LXI+x&n3s{k<ryh{{H3r$1neWiN5hQ`u^9m%k@pJ5wTA{y<Fe)"
    "Ix+dv{JyUyMsy}dAAfc9*<TwmB1<YprqzS38NsSgO-HqD%Taq6Mj!Nb-|z|Ydpcdb7!3vNg&)C8SUjpl3I7~XG6}52#;IKzwkW|;"
    "lbZE>xh3huVy(4Rs4VZrsK|O2@4y)&E}b2QqX%Fr!ikFMmXM@zH1wl5p0l?W`_<M_M2V;@MHuDobXK`~Yx>dTNM*5hq$;-@EO|MK"
    "hjp?IV4dqzT_t+oP-)-jsgCO*)r5_cPJ6mdeDYY4Il)9IqDkmSJ5wIMHLaldDLQxZiSXi(B{NMH>sZI8W@*T2=shY9Adni#aFcQN"
    ";HNd>I$~f*G5GQGfBx{^Um7u>ODYB+1=Q^ii0YcOuVTM%sfK5QAHHkqCb9=a?=4;oMv&=c`u={(I2?j&K_FKa1gaC;yhsr!Le##^"
    "iXeCR%clv8Wu7UScl?KMj-Ne+?bYE2-!}X+mXv?qz(RQ7!#eE4$zY(HhU(cSg;(F9j^nyEbr;XSJRaVkPUcaNUVTkAk$xcsZ~daY"
    "tOT4b$`}r3hU@xjPq%E9Qdd_U;!)MHJge^w27S^S%ogPwh6)qNj_a<)ub%w-H?N+&T);}KwJ!rDE3y{1UDq+OXS=G4s1Lgj$5MMf"
    "P|P<7rJif|JTfS_ogsRb+hDvLx3lz}kY{OBUZEnrrgsS;>_Z&KwjHY1JgPXHo#1eNH5$bHO_p`GcM$CB1cLbQLut4RrR^PD*l=OP"
    "g$+t92*N}_jk+K$SXyRvh_n!Cq0&O7#gG<5T1;sHWgW*+vJ1f|9!h7F#&1*xS*k8tK}9y$K{^%phBXo`OLdirs6}nyJdDEE3JbqC"
    "wCd2DZ7%l91kTHHah-SWF1Q06c*wT59@RXqxLXo8WE+Xgcgt(x;%YmoU*Xdj(hNj-bD9LA_+Iv$Y-K?uqrqlSGtto-CblcM#l`f="
    "sx!jQzHU$Nr%82#(9(p;$=#4ASI`ITH2cAwVoD`dM=Suk{&w;^H5RqvvQr;IR^LqLr#=LE-S=EAIT`(|RM#_5Oc>t)gmJb1iV_eF"
    "2&yU#%Y&52tE#A_t}U?q6!f==PLD?nyv|sX=J2Xx-G$|i!c+bO4rP%D#y*=waj~R<As92BhhnCJ+fxrLrMauTdh&&GIvudRsB}oq"
    "ONZpVbVx2vhq8zp$W7a@ZwTbZG9kV&0r&+G#|`47K^)FdL|;LEb;$J_06A$Or!B|<Uc7?*%8;X*pzE}O+-NQ3x?#~3<hK)Yqk-IP"
    "L2e*=Q?_p_$gc>w*+6c!Aa^XZ+P>XV$gKu)yMdfg?5wtLw-j=_f!t|9ZrkQ+`*uqqcjPTi>s}^XOT{?kvs)Tyu~{WXJ-ham>#Wnw"
    "S?;v1bQY2%H!a5VuRhA330Cnr_o6@sVHKZqPSwOh3sT{m7NGfOP-J7<UIpla6I;2AuL5-b`9}WQyb91crvY$xCDIq|olV19iS)^x"
    "W_xp~wSTD9TK|=4{r^x)0|XQR000O8K!x*MR+VJ$v;zPDKMDW<ApigXaBy@lb8Km3WlUjtZ*_EYFLP{ZWMxcYd2e-eH!gT>Y|WNi"
    "iyTE1$KM6NL(@LjcJ;k`$ZY7V2%Fu-Nj^ZOyJn|JU&`v5$xOmR1VMZVd5b85`k){PK8YC2mkB1L-@?<E%1+!B7jYmjUDc=0sXFKU"
    "e_h=-Zmz3RSyA2=O+8ih1FR~v&YHZa&!*~~+bQx?r4^*kN!iqNs%~hj-aLHwof~Y@miZCcG)tkt8g)A%Q*|K(n`l~_EoepBgND%>"
    "p3NIx5dpXSOv^dB4{KMYW?<}S6)9?UjOW*hZ|3tNqj8fhD_V<T5l%}YApdqzuvV_duCp5Bw1s8*=r>am8wS<hElGV(ReCqR0)ws|"
    "Lgm@4%$1r{VA%ffZ2QIY-rBO;oYHPquiocu#!h+fe7rj4N|ATLW00zi4@Ng_2<j)=-@?!2luXuhUUeh%Kv_>!kZRLiwa!M@LdgbW"
    "c45sHCs+7pi{uJ#O>Us=Y}!>dBzL(SLzeUE^Y31L_4Uig-~9gk@%G2>m99yBMn|oXxh;7yRUf9Q5!y*=p%iAw!l8x2#PU&Um|kMI"
    "X=Iqrc^9oalZ?||mk)Bum+oBBv??;*w9Q-`WKA`~AsGWXb!(Kf%lDxb1hF57HcH$$L1|zc$n`PIB5a2tw(S%f=VL1%XF2v&Xk+DL"
    "3#241J8H6ftx`82S*NfjU1h)OF^DZjrg8yq)B~u5l=ChzkU__)RK9c8cKh8*KEyg~@=dqtT^M^KnUt-ViA_oS8`fRsfM#E<lenoK"
    "TNs%*wviRv0rJC0M~-bf*b1;`rslZ>Jtu;SqM~VWw&e6=DS8PxC=G7_oCFURC^}XZQi`Mgp4RBj4C<&vR8msEMoSzT*l;vg)BUb{"
    "Lk}UP9)mhRC7gWtFN+TSXMG!F&6?!!pJ_BDjemao^B<plc|oJ`meOeGMy#iHf&$P6C86t~&@mk3r5%W2sC!Pde;Vh44>*3bBwSD~"
    "iPZl;BKNDiC3W9^{L}WcPq)84efi{<3-!&nRDB1hUhMktPC7<{5+lLLHf<kaGj=@7i6cLX_pd&D!jG5Ll>iufIFbxoH{qmBQGkJV"
    "%L*~_&B#K&8@X|mB(WJJuaBg*EOJ^ycK`JxdhzJj_g*}Dwuf^_+x^%}RoD(&VF<EDUWh{7O5yDFT@<8_jZ)jRtSIz?$V@u6m~LHW"
    "3yjxei#7KtXHC)n2kCgkYeh<s&oW)l$A;^SG7b!}HyE0A{eZFLw+K5~^$@{k072B7SO@Oldf}q&{P-RI1yD-^1QY-O00;m;h4WmG"
    "4joX+0002J0RR9j0001RaC9$oY-wa=O<{9%WpZ;bUvgz^b1!pjX=G(hVRLk4axpG=ZEP-bWo&b;kWFgCFc5{WB4%I7&LSx#N;V}B"
    "$f~3V7^JZ+YD+>h3H9wGQVKC-(M2}{^Ygy<nC<?18r78whZHTex&cMeB_CpM;q!cWc?HFS(c_pRS(u4ozuSJ$h*Bjygv_ckB3l?l"
    "@|!X22AYs{$`tFSOJzc-ZRt%$_k}%~Rnx3Zd1SznsgB-4Ir<H#^PK4~?9_F^(R*^2iK0BQFgylNC!EtoDi%vmVnOT2`Qm7!s|A?n"
    "$=cO_Mw6<gMX3Aar?$U2%;N348&FFF1QY-O00;m;h4Wn1(US4D0000t0RR9j0001RaC9$oY-wa=OksI%b#!wtUvgz^b1!pjX=G(g"
    "VR>(LbT=+|ZEP-bWo&be&%Fx5Fc1guUGN>k?Ix{*h%|K(!NEoJ0gmL_2HPa$qUhV3(Sn2Hef|Divwuyacv4~)yoOp<Ajq3wo$oc="
    "uE*6D1ZVUX$KXlBn;7=(a?xC9#9WSeaFIn(JZl(ojyt8;3^XCj5XqNG7t(~el&Mz{%^iDE>#EwQ^ld;pGsVejNGDr^xV|I(V~4JD"
    "h7Q3zCi3}5gyPXzIwNOFg~ilU)*$6~f3{T15&^1h)a>2%15ir?1QY-O00;m;h4Wl_C}-sM1^@sWA^-ps0001RaC9$pXk~3>FLY>S"
    "ZDlbocx`O$T3e6XL==8U;y+k^Pkl+8%c?2Lm0ot+)$X>4$B8|$rx|;qnaS=(s8Us)5E2p+puQj>UU)!=N+40e1OJ60s#1Og<FVs-"
    "k}<t)p%S}Wbu;7dJM;ORGiOemTzuy=#>O$E43VU3Iu~ryfQe56l!RUL=Fzy;HVwu>5&%pR*fp1sneSYB`>l&$het4mhTtb`2XxJd"
    "^ZAZtF<(prc7e=cBCbsdjR6-!8d?DbC&F%wE!Vc2Rt!*L8VQJn*&EX-@}cqj!(X0!egC(+AB%tHrPUfEEdEP4ODB9x4}H0CnJBTr"
    "%t`;SB^zLB90S}n#c}~TIfAF$G%#RXT<Ds%{4uRd7p;PXc?Gw`8_S=ZmlJ}SD|s}W6hwREwi`}i-_7iA<3{cDx3DJx!1u+SI$K!B"
    "Yuar$$Cg0ZOO5SL%c-mQlKuL&{Z6y*HWYk)jc;t<<G3>#dJ4X=#(P`%p6&KKbp`LO@y#uKW7KQ8BLy!(5k|>u8{KTR+szzZK&Av="
    "*1|i@rrjFm@HNURWmm>ecvY^&;5MOS0g%B393=){&fygJ0{8g4j~@U0tFep1NaWodB!r1s+jSg~cMaPuex<{~4g@7~Hs!OesZ@@^"
    "e2V70YhD#r%@X8~hYug!`|;7epB{bq;iG%s=WB2CE`ua2^PYb5>0e*oHU9kJtEZoRuE#U8>ejSyuE_f0!Q&qv{Bi%2C*OXif%hnw"
    "l;KAxhRnDQPmBW+iyPD|04Mat7)KF6WkxRv8Aw3N(V#~>Qqb3z00RxK4^=<jqM};pfbTADD}oOry5L9yycWd@aE}n&Cscb+*V47h"
    "URWfdesQ`e;|>5g)~!9*i1KJL7io`lCI=BzWbR`TauC7<awEM)W)Ny<?<1u6br1QJFf!%F`^e}6q;<&=ns7boGKxi9mO6nV-imMb"
    "ZW(=ob>@fgSVfAx0kF;_#EKi=1q%*htzr=4GIAI2NGI}eNqxoPjEhKz5EEk*K*n^O8+572y#_?t(uRExFJl!+IhyH^yMT}~a!6)_"
    "2*h)(W|Tx_>=iZ>DGH2z!nGoZx<k^jhyzF}!+i@u{$hLkrYJ-D1WB(fsBTL@qVC5fo&u;d-lMTnVtW*6v!lNVmDJva5Q7sCKxo{&"
    "qQjFp(TlzsiK=oL>U?t*sJWVs6Ud+;dmBw)5mQq35Qd~e&)#yQ@GL<R16pPI`b<rk(S(Z4sLNOE&y-S%Xu4_jB5tr4JeSq|2q<Zl"
    "j+s7Rmo$0NJtjD}UxEW)m?H}NbNl89V5m=+BY=!uUAYyMg`SdbCrMjqc~f=MuESt$^gJ<2p49;TH?7ZWYkJPU-KnZ5n@vs?ZnL!+"
    "5E`I2zq1*FMY0dYVRGKsoHsWA$Ht~=KcBZV=k3gSJM*u#GwTk<DnIOzR^rMhKU0M9Azxy+%Vh7v#NH3aVp0wysd&&dkHpJ-IRzI|"
    "AYU7l@b?gp4kIuZ%Q$j{kmaUBX3Pl_?UPw)TXtWIc#j16b3AADY*P>bU(efKF)w;Gp3OE}>j$BQc{vJMS%4>vKEH_4VycL`MntRr"
    "d?FnCtW<O~D%#FJsjx~>5r>lj(x>BIBU2>OO{8>?#wp{kqI>3%u5zY&+pgyJI*l`nv?8LEZmNh<8b;#q*qlD&Sa&-5P`g?gt@i7P"
    "wY6OvaH5WklT=eHwc~?%*PMzsPU2-e7Y12cssIj?uIcmK(=St6=9KXvU{MB>mof*$h(l^%6pLgp#{nlLaUHQ~-c)gJ8iY4ZoV6Kc"
    "IGsYDSIn%3;#y`zd-WB;>3}SR=))*DF(!CH4}fr#*K*S628i(@)B&QU>|T3uqh95EQTYgHy+;9_M<72^%GErB%h!dR(tSv!n|EdD"
    "TsR5GXL0O4o3v3iD^8GBWf^;Yr+i6OU9Za17Q0T{{^w)j)lY<yw6<PaT`#Tb@HoScptM}G!f$S6G+*&J*vwk1)L6>V)~DNKa$98n"
    "P_(NHoXy}wjHKlGK9$-hBv|GzG0S#Ic2BD^fRh6_HBfLWN~X>^`Nzja5j)5hNDr@qsP(E!%<=2OQ;?l!lMBYGXD`UIE!P>~r^U({"
    "J_}e;HF8f`IxmX%eiRH=AMR%5RL-tS^eHzM6m`uHY_HcCxZa><x4luVQE%9_w%4oIdY)HzMxJ92`|cefk4LfNWdR(67~y69MF=^+"
    "^<{{7^@inwPhyM6cN3N*%P&JXuI|eaN9lD_ctyx^M^3}-xr5qZ=rn5$ci618TlHRT;5LVDPgL^exOc}ijwRUX4~OHi=hm77fos@3"
    "uh#3=2eoE<)OW|us4=t!I1j`rU;SO>sMK}oZ%|7E1QY-O00;m;h4WmaWFu>Z0RR9p0{{RK0001RaC9$la%FQ+a&K^RE_iKht<v3U"
    "+b|dg;Pb)m!RTDkpMPQ#r`VALgB^_0U4W3~M9i{;q_iDl_dYF6yL4kv#*QQ*-cQdbX>;>v=ImbipzYEEvce!!i?pL&4lVe6w})$x"
    "g(#L$%yv;N_^JZ9*}i|bagFmTs3nS+qMv-03N4`#EjY&L8iay8DkH+mI<=&|$$BGVTKWSTy?96mm>E%wOJsyzz$NeBlDE^OrQ%ke"
    "OaeR=@oGLx!cn{MT+O|u+I1hVNZZt;dW;`Kyv(wb*Dd%qRON1{^A47n?O;xF3j2EKVaW-rFebR8)%Txik~gCcQuy(M5eGGlI&u-k"
    "Gmhkc@Qjw;20O)-wC2($a`r)aXZ5*Nf-m=VFXk3tfVLZS#=SOjMmk*54p#NLgE^x$?0U{&-*@YxEGaGsele;^oaT5oa;N_zkI|~E"
    "{zlyMV%T>bhj`cxFfZ5u>op@VFMG=RAq^~lA{LE23Lo#hkYCcjxm8myf*N0-#lJx5HI!T<(XVGmzkl=X4^T@31QY-O00;m;h4Wl2"
    "w{%@&0RR950{{RK0001RaC9$rX=Qg%a&K^RE_iKhjgmcY!ypib_e%W_h`qsyQa80?XQ|pHL#4Rg5nu-i0|JuR{q;R#r}=1xO!nP-"
    "_wwAqa@95p?S=Ew=p0Wc2}VLQ!=<is{8hd`Eim$dYEG5WBFCNZcvU<;EN!-z;_&GZ7-*l-9B)Ig86lo+MMM3>SfN3yjB99s(A9)H"
    "dH~}_ky(<Yq@hydvESX(Z>mZ%@n+br5jqSePAD1x-fyM#M>l(qn{~p2P3*ovDquL>7pm_#Vjn|oFi!Bbr~>jou&U>DmSA$OmBvQt"
    "b)KeCBL987l3biZwo!bDkk{0f=EF&z<0LY$QQ1?sVN}8Pr!nvQpjgt(x2V6gWR4N<zwuB=cQ?}Hug_-2$y#dE=6JS%qAthjVys~&"
    "wt5GsYad48k96?5oI{%+d@0&+Hrm<HSHJ_;1?(wx8#IZS$u%Xpd2|g++*r!stsw@@FL1Z;j#+p79bAS7T>Ju1O9KQH0000806>NF"
    "T-g1MkEH+r0JZ=C022TJ0B~@0FLYsIY-Lk)d2D5KE_iKh4a`Xnf-o3B;k}7>X#RaILs29Y!XPVm>H#X0A?ZM9qY~rYW%=@wFU>zn"
    "qL*0gWHbZ+-~kf4HQl5K29JA#V?fq%-EnEOV6X}cdA8rBJaJEXbE_0r>(HiXn{WoBb8|w7ZAYQFJ(yYO?e%6++-<oGq+9rV)0HHF"
    "=N*aSlLpj@p20V&f*_)_z^BXQh-pXzTzWLdaa7jTxvBjsEPg<;KTt~n0u%rg0000806>NFT&^28MM41p0N4Zo022TJ0000000000"
    "0Du7i00016LvL<$Wo~p|RC#b^b6qZYZER3W0Rj{N6aWAK2mnBZ^ISQ+GOpMF006%M000XB0000000000004jia{&MVUvgz^b1yD("
    "Wo&a$O928D02BZK00;m;h4WlqmgXb)0000>0{{RY00000000000001h0dxWY0B~@0FJE$HY;!Mga%FR6ZggREX>V>Wcx`Mha%F6D"
    "P)h*<6aW+e000O8K!x*Mqjjfm6#@VNR15$B6aWAK0000000000fB~rk003}sbT4pnWpib2bYXO9Z*DGlZER3W0Rj{N6aWAK2mnBZ"
    "^IU{j6v*!f000p+001EX0000000000004ji@C5(>aBy@lb8Km3WldpobY*gLFLP{ZWMxfZb97~LF)ny*Y*0%90u%rg0000806>NF"
    "TvnB2@3aE|06z)<03iSX00000000000Du7=4gdgfaC9$oY-wa=OksI%b#!wtb8Km3WlUjtZ*_DxE_iKhP)h*<6aW+e000O8K!x*M"
    "j}9GB$^ZZWy#W9KEC2ui0000000000fB_K_003}sbT4ykX=G(hVRLk4a&s?Va%F6DFLP{ZWMxfZb97~LF)ny*Y%X$TY;#ac0Rj{N"
    "6aWAK2mnBZ^IX-@lJT|x001`u001li0000000000004jiB@+MuaBy@lb8Km3WlUjtZ*_EYFJE$HY;!MjY-wa=OksI%b#yl_cx`Mh"
    "a%F6DP)h*<6aW+e000O8K!x*Mc_?S(_67g|8X^Dy6aWAK0000000000fB_{G003}sbT4#hWo>0IbZBL5Wic*zZER3W0Rj{N6aWAK"
    "2mnBZ^IW53BWr~L001%r000pH0000000000004jiO&b6JaBy@laB^jHP;zf@b1ryoY*0%90u%rg0000806>NFTr9VAU1I?N00aX7"
    "01*HH00000000000Du7j9RL7uaC9$rX=Qg%a&K^RE_iKhP)h*<6aW+e000O8K!x*M*!_)<r2qf`wg3PC6951J0000000000fB};p"
    "003}sbT4#aVr*qoba`xLb1ryoY*0%D1^@s601N;O09*qA0BIip0000"
)


def _shape(shape_id: int, name: str, text: str, x: int, y: int, cx: int, cy: int, size: int) -> str:
    paragraphs = str(text).splitlines() or [""]
    runs = "".join(
        '<a:p><a:r><a:rPr lang="zh-CN" dirty="0" '
        f'sz="{size}"/><a:t>{escape(line)}</a:t></a:r><a:endParaRPr lang="zh-CN"/></a:p>'
        for line in paragraphs
    )
    return (
        '<p:sp><p:nvSpPr>'
        f'<p:cNvPr id="{shape_id}" name="{escape(name, {chr(34): "&quot;"})}"/>'
        '<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>'
        f'<a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln>'
        f'</p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>{runs}</p:txBody></p:sp>'
    )


def _group_shape_tree(inner: str = "") -> str:
    return (
        '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/>'
        '</p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        f"{inner}</p:spTree>"
    )


def _slide_xml(title: str, body: str) -> str:
    shapes = _shape(2, "Title", title, 685800, 457200, 10820400, 1143000, 2800)
    shapes += _shape(3, "Body", body, 914400, 1828800, 10287000, 4114800, 1800)
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sld xmlns:a="{_DML}" xmlns:r="{_REL}" xmlns:p="{_PML}">'
        f"<p:cSld>{_group_shape_tree(shapes)}</p:cSld>"
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
    )


def _theme_xml() -> str:
    colors = (
        '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
        '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
        '<a:dk2><a:srgbClr val="1F1F1F"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2>'
        '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
        '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
        '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
        '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
    )
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<a:theme xmlns:a="{_DML}" name="Office"><a:themeElements>'
        f'<a:clrScheme name="Default">{colors}</a:clrScheme>'
        '<a:fontScheme name="Default"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/>'
        '<a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/>'
        '<a:cs typeface=""/></a:minorFont></a:fontScheme>'
        '<a:fmtScheme name="Default"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/>'
        '</a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill>'
        '<a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst>'
        '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>'
        '</a:themeElements></a:theme>'
    )


def _pptx_bytes(slides: list[dict[str, str]]) -> bytes:
    overrides = "".join(
        f'<Override PartName="/ppt/slides/slide{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for index in range(1, len(slides) + 1)
    )
    slide_ids = "".join(
        f'<p:sldId id="{255 + index}" r:id="rId{index + 1}"/>'
        for index in range(1, len(slides) + 1)
    )
    slide_rels = "".join(
        f'<Relationship Id="rId{index + 1}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
        f'Target="slides/slide{index}.xml"/>'
        for index in range(1, len(slides) + 1)
    )
    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:presentation xmlns:a="{_DML}" xmlns:r="{_REL}" xmlns:p="{_PML}">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        f"<p:sldIdLst>{slide_ids}</p:sldIdLst>"
        '<p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>'
        '<p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
    )
    master = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sldMaster xmlns:a="{_DML}" xmlns:r="{_REL}" xmlns:p="{_PML}">'
        f'<p:cSld name="">{_group_shape_tree()}</p:cSld>'
        '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" '
        'accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" '
        'hlink="hlink" tx1="dk1" tx2="dk2"/>'
        '<p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
    )
    layout = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<p:sldLayout xmlns:a="{_DML}" xmlns:r="{_REL}" xmlns:p="{_PML}" type="blank" preserve="1">'
        f'<p:cSld name="Blank">{_group_shape_tree()}</p:cSld>'
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/ppt/presentation.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
            '<Override PartName="/ppt/slideMasters/slideMaster1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
            '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
            '<Override PartName="/ppt/theme/theme1.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
            f"{overrides}</Types>",
        )
        package.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="ppt/presentation.xml"/></Relationships>',
        )
        package.writestr("ppt/presentation.xml", presentation)
        package.writestr(
            "ppt/_rels/presentation.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" '
            f'Target="slideMasters/slideMaster1.xml"/>{slide_rels}</Relationships>',
        )
        package.writestr("ppt/slideMasters/slideMaster1.xml", master)
        package.writestr(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
            'Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" '
            'Target="../theme/theme1.xml"/></Relationships>',
        )
        package.writestr("ppt/slideLayouts/slideLayout1.xml", layout)
        package.writestr(
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" '
            'Target="../slideMasters/slideMaster1.xml"/></Relationships>',
        )
        package.writestr("ppt/theme/theme1.xml", _theme_xml())
        for index, slide in enumerate(slides, 1):
            package.writestr(f"ppt/slides/slide{index}.xml", _slide_xml(slide["title"], slide["body"]))
            package.writestr(
                f"ppt/slides/_rels/slide{index}.xml.rels",
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
                'Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
            )
    return buffer.getvalue()


def _pptx_template_bytes(slides: list[dict[str, str]]) -> bytes:
    with zipfile.ZipFile(io.BytesIO(base64.b85decode(_PPTX_TEMPLATE_B85))) as template:
        files = {name: template.read(name) for name in template.namelist()}

    overrides = "".join(
        f'<Override PartName="/ppt/slides/slide{index}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        for index in range(1, len(slides) + 1)
    )
    content_types = files["[Content_Types].xml"].decode("utf-8")
    files["[Content_Types].xml"] = content_types.replace(
        "</Types>",
        f"{overrides}</Types>",
    ).encode("utf-8")

    slide_ids = "".join(
        f'<p:sldId id="{255 + index}" r:id="rId{20 + index}"/>'
        for index in range(1, len(slides) + 1)
    )
    presentation = files["ppt/presentation.xml"].decode("utf-8")
    files["ppt/presentation.xml"] = presentation.replace(
        "</p:sldMasterIdLst>",
        f"</p:sldMasterIdLst><p:sldIdLst>{slide_ids}</p:sldIdLst>",
    ).encode("utf-8")

    slide_relationships = "".join(
        f'<Relationship Id="rId{20 + index}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" '
        f'Target="slides/slide{index}.xml"/>'
        for index in range(1, len(slides) + 1)
    )
    relationships = files["ppt/_rels/presentation.xml.rels"].decode("utf-8")
    files["ppt/_rels/presentation.xml.rels"] = relationships.replace(
        "</Relationships>",
        f"{slide_relationships}</Relationships>",
    ).encode("utf-8")

    slide_layout_relationship = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" '
        'Target="../slideLayouts/slideLayout7.xml"/></Relationships>'
    ).encode("utf-8")
    for index, slide in enumerate(slides, 1):
        files[f"ppt/slides/slide{index}.xml"] = _slide_xml(
            slide["title"],
            slide["body"],
        ).encode("utf-8")
        files[f"ppt/slides/_rels/slide{index}.xml.rels"] = slide_layout_relationship

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for name, payload in files.items():
            package.writestr(name, payload)
    return buffer.getvalue()


def _slides(value) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        raise ValueError("slides_json must contain a non-empty array")
    if len(value) > _MAX_SLIDES:
        raise ValueError(f"presentation is limited to {_MAX_SLIDES} slides")
    normalized = []
    for index, item in enumerate(value, 1):
        if isinstance(item, str):
            title, body = f"Slide {index}", item
        elif isinstance(item, dict):
            title, body = str(item.get("title", "")), str(item.get("body", ""))
        else:
            raise ValueError("each slide must be a string or an object with title/body")
        if len(title) + len(body) > _MAX_TEXT_CHARS:
            raise ValueError(f"slide {index} is too large")
        normalized.append({"title": title, "body": body})
    return normalized


@register_tool(
    "write_pptx",
    "Create a real .pptx presentation from a JSON array of slides. Each slide may contain title and body fields.",
    keywords=["pptx", "presentation", "slides", "演示文稿", "生成幻灯片"],
    params=[
        ParamSchema("filename", "path", "target .pptx filename"),
        ParamSchema("slides_json", "string", "JSON array of {title, body} slide objects"),
    ],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def write_pptx(filename: str, slides_json: str) -> str:
    slides = _slides(_json_value(slides_json, "slides_json"))
    return _write(_target(filename, ".pptx"), _pptx_template_bytes(slides))


def _pdf_bytes(content: str) -> bytes:
    source_lines = str(content).splitlines() or [""]
    if sum(len(line) for line in source_lines) > _MAX_TEXT_CHARS:
        raise ValueError("PDF content is too large")

    def display_width(value: str) -> int:
        return sum(
            2 if unicodedata.east_asian_width(char) in {"W", "F", "A"} else 1
            for char in value
        )

    def split_width(value: str, limit: int) -> list[str]:
        if not value:
            return [""]
        result: list[str] = []
        remaining = value
        while remaining:
            width = 0
            cut = 0
            last_space = -1
            for index, char in enumerate(remaining):
                width += 2 if unicodedata.east_asian_width(char) in {"W", "F", "A"} else 1
                if char.isspace():
                    last_space = index
                if width > limit:
                    cut = last_space + 1 if last_space >= max(0, index - 24) else index
                    break
            else:
                result.append(remaining.rstrip())
                break
            cut = max(1, cut)
            result.append(remaining[:cut].rstrip())
            remaining = remaining[cut:].lstrip()
        return result or [""]

    # Convert the same lightweight Markdown accepted by write_docx into
    # paginated text records.  The former implementation paginated only on
    # explicit newlines, so long prose ran beyond the right edge and a full
    # thesis could collapse into one or two unusable pages.
    records: list[tuple[str, int, int]] = []
    for raw in source_lines:
        stripped = raw.strip()
        if stripped in {"<!-- pagebreak -->", "\\pagebreak", "[PAGE BREAK]"}:
            records.append(("\x00PAGEBREAK", 0, 0))
            continue
        if (
            stripped in {"---", "***", "___"}
            or stripped.startswith("<!--")
            or stripped.endswith("-->")
            or re.fullmatch(
                r"\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?",
                stripped,
            )
        ):
            # Markdown thematic rules, comments and table separator rows are
            # source syntax, not visible academic-document content.
            continue
        heading = re.match(r"^(#{1,6})\s+(.+?)\s*#*\s*$", stripped)
        if heading:
            level = len(heading.group(1))
            text = heading.group(2).replace("**", "").replace("`", "").strip()
            if (
                records
                and level <= 2
                and re.match(
                    r"^(?:目录|摘要|abstract|第[一二三四五六七八九十\d]+章|"
                    r"[一二三四五六七八九十]+、|参考文献|致谢)",
                    text,
                    re.IGNORECASE,
                )
            ):
                records.append(("\x00PAGEBREAK", 0, 0))
            size = 20 if level == 1 else 16 if level == 2 else 14
            leading = size + 8
            limit = 48 if level == 1 else 58
        else:
            text = re.sub(r"!\[([^\]]*)\]\([^)]+\)", r"\1", stripped)
            text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
            text = text.replace("**", "").replace("__", "").replace("`", "")
            text = re.sub(r"^\s*>\s?", "", text)
            if text.startswith("|") and text.endswith("|"):
                text = "\u3000".join(cell.strip() for cell in text.strip("|").split("|"))
            text = re.sub(r"^\s*[-*+]\s+", "• ", text)
            size = 12
            leading = 19
            limit = 82
        # Markdown authors often place an ASCII space at every CJK/Latin
        # boundary. When the PDF switches between Helvetica and the CID font,
        # that explicit space becomes visually much wider than in Word. Remove
        # only boundary spaces; ordinary English word spacing is preserved.
        text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[A-Za-z0-9])", "", text)
        text = re.sub(r"(?<=[A-Za-z0-9])\s+(?=[\u3400-\u9fff])", "", text)
        if display_width(text) <= limit:
            records.append((text, size, leading))
        else:
            records.extend((part, size, leading) for part in split_width(text, limit))

    chunks: list[list[tuple[str, int, int]]] = []
    current: list[tuple[str, int, int]] = []
    available = 700
    consumed = 0
    for record in records or [("", 12, 19)]:
        if record[0] == "\x00PAGEBREAK":
            if current:
                chunks.append(current)
                current = []
                consumed = 0
            continue
        if current and consumed + record[2] > available:
            chunks.append(current)
            current = []
            consumed = 0
        current.append(record)
        consumed += record[2]
    if current:
        chunks.append(current)

    objects: dict[int, bytes] = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        3: b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>",
        4: (
            b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
            b"/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 0 >> "
            b"/DW 1000 /FontDescriptor << /Type /FontDescriptor /Ascent 752 "
            b"/CapHeight 737 /Descent -271 /Flags 6 /FontBBox [-25 -254 1000 880] "
            b"/FontName /STSongStd-Light /ItalicAngle 0 /Leading 148 /MaxWidth 1000 "
            b"/MissingWidth 500 /StemH 91 /StemV 58 /XHeight 553 >> "
            b"/W [1 [207 270 342 467 462 797 710 239 374] "
            b"10 [374 423 605 238 375 238 334 462] 18 26 462 27 28 238 29 31 605 "
            b"32 [344 748 684 560 695 739 563 511 729 793 318 312 666 526 896 758 "
            b"772 544 772 628 465 607 753 711 972 647 620 607 374 333 374 606 500 "
            b"239 417 503 427 529 415 264 444 518 241 230 495 228 793 527 524] "
            b"81 [524 504 338 336 277 517 450 652 466 452 407 370 258 370 605]] >>"
        ),
        5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    }

    def text_commands(line: str, size: int) -> list[bytes]:
        """Render ASCII with Helvetica and CJK with the Unicode CID font."""
        if not line:
            return [f"/F1 {size} Tf".encode("ascii"), b"<FEFF> Tj"]
        commands: list[bytes] = []
        start = 0
        ascii_run = line[0].isascii() and line[0] not in "\r\n"
        for index in range(1, len(line) + 1):
            next_ascii = (
                index < len(line)
                and line[index].isascii()
                and line[index] not in "\r\n"
            )
            if index < len(line) and next_ascii == ascii_run:
                continue
            run = line[start:index]
            if ascii_run:
                escaped = (
                    run.replace("\\", "\\\\")
                    .replace("(", "\\(")
                    .replace(")", "\\)")
                )
                commands.append(f"/F2 {size} Tf".encode("ascii"))
                commands.append(b"(" + escaped.encode("ascii", errors="replace") + b") Tj")
            else:
                encoded = ("\ufeff" + run).encode("utf-16-be").hex().upper().encode("ascii")
                commands.append(f"/F1 {size} Tf".encode("ascii"))
                commands.append(b"<" + encoded + b"> Tj")
            start = index
            ascii_run = next_ascii
        return commands

    page_ids = []
    for index, chunk in enumerate(chunks):
        page_id = 6 + index * 2
        stream_id = page_id + 1
        page_ids.append(page_id)
        commands = [b"BT 50 790 Td"]
        previous_leading = 0
        for line_index, (line, size, leading) in enumerate(chunk):
            if line_index:
                commands.append(f"0 -{previous_leading} Td".encode("ascii"))
            commands.extend(text_commands(line, size))
            previous_leading = leading
        commands.extend(
            (
                b"ET",
                b"BT /F2 9 Tf 285 28 Td",
                b"(" + str(index + 1).encode("ascii") + b") Tj",
                b"ET",
            )
        )
        stream = b"\n".join(commands)
        objects[stream_id] = b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream)
        objects[page_id] = (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            f"/Resources << /Font << /F1 3 0 R /F2 5 0 R >> >> /Contents {stream_id} 0 R >>"
        ).encode("ascii")
    objects[2] = (
        f"<< /Type /Pages /Count {len(page_ids)} /Kids [{' '.join(f'{item} 0 R' for item in page_ids)}] >>"
    ).encode("ascii")
    maximum = max(objects)
    output = bytearray(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
    offsets = [0] * (maximum + 1)
    for object_id in range(1, maximum + 1):
        offsets[object_id] = len(output)
        output.extend(f"{object_id} 0 obj\n".encode("ascii"))
        output.extend(objects[object_id])
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {maximum + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {maximum + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    )
    return bytes(output)


@register_tool(
    "write_pdf",
    "Create an A4 text PDF with Unicode CJK support, Markdown-aware headings, "
    "automatic line wrapping, pagination, and page numbers.",
    keywords=["pdf", "export pdf", "生成pdf", "导出pdf"],
    params=[
        ParamSchema("filename", "path", "target .pdf filename"),
        ParamSchema("content", "string", "full text or Markdown content; line breaks are preserved"),
    ],
    risk="medium",
    requires_confirmation=True,
    category="workspace_write",
    source=__name__,
)
def write_pdf(filename: str, content: str) -> str:
    return _write(_target(filename, ".pdf"), _pdf_bytes(content))


def _office_text(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".txt", ".md", ".csv", ".tsv", ".json"}:
        return path.read_text(encoding="utf-8", errors="replace")
    if suffix not in {".docx", ".xlsx", ".pptx"}:
        raise ValueError("supported formats: .docx, .xlsx, .pptx, .txt, .md, .csv, .tsv, .json")
    with zipfile.ZipFile(path) as package:
        if suffix == ".docx":
            root = ET.fromstring(package.read("word/document.xml"))
            namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
            lines = []
            for paragraph in root.iter(namespace + "p"):
                text = "".join(node.text or "" for node in paragraph.iter(namespace + "t"))
                lines.append(text)
            return "\n".join(lines)
        if suffix == ".pptx":
            names = sorted(
                (name for name in package.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)),
                key=lambda name: int(re.search(r"\d+", name).group()),
            )
            return "\n\n".join(
                "\n".join(node.text or "" for node in ET.fromstring(package.read(name)).iter(f"{{{_DML}}}t"))
                for name in names
            )
        shared = []
        if "xl/sharedStrings.xml" in package.namelist():
            shared_root = ET.fromstring(package.read("xl/sharedStrings.xml"))
            shared = ["".join(node.itertext()) for node in shared_root]
        sheet_names = sorted(
            (name for name in package.namelist() if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)),
            key=lambda name: int(re.search(r"\d+", name).group()),
        )
        rows = []
        main = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
        for name in sheet_names:
            root = ET.fromstring(package.read(name))
            for row in root.iter(main + "row"):
                values = []
                for cell in row.findall(main + "c"):
                    cell_type = cell.attrib.get("t")
                    if cell_type == "inlineStr":
                        values.append("".join(node.text or "" for node in cell.iter(main + "t")))
                    else:
                        node = cell.find(main + "v")
                        value = node.text if node is not None and node.text is not None else ""
                        if cell_type == "s" and value.isdigit() and int(value) < len(shared):
                            value = shared[int(value)]
                        values.append(value)
                rows.append("\t".join(values))
        return "\n".join(rows)


@register_tool(
    "read_office_document",
    "Extract text from a workspace DOCX, XLSX, PPTX, text, CSV, TSV, or JSON file without launching another app.",
    keywords=["read docx", "read xlsx", "read pptx", "extract office", "读取文档", "提取表格"],
    params=[
        ParamSchema("filename", "path", "document path inside the active workspace"),
        ParamSchema("max_chars", "int", "maximum returned text characters", required=False, default=40000),
    ],
    risk="low",
    category="read",
    source=__name__,
)
def read_office_document(filename: str, max_chars: int = 40_000) -> str:
    path = _file_tools()._resolve(filename)
    if not path.is_file():
        raise OSError(f"file not found: {filename}")
    limit = max(1_000, min(int(max_chars), 120_000))
    text = _office_text(path)
    truncated = len(text) > limit
    return json.dumps(
        {
            "path": str(path),
            "format": path.suffix.lower(),
            "text": text[:limit],
            "characters": len(text),
            "truncated": truncated,
        },
        ensure_ascii=False,
        indent=2,
    )


__all__ = ["read_office_document", "write_pdf", "write_pptx", "write_xlsx"]
