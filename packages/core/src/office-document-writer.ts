import { deflateRawSync } from "node:zlib"

/**
 * Bounded, deterministic XLSX encoder used by the future Core document
 * mutation seam.  It deliberately returns bytes instead of touching the
 * filesystem so callers must still pass the result through FileMutation,
 * LocationMutation and the normal permission/ActionGateway pipeline.
 */

export const MAX_XLSX_ROWS = 2_000
export const MAX_XLSX_COLUMNS = 100
export const MAX_XLSX_CELL_CHARS = 32_767
export const MAX_XLSX_TEXT_CHARS = 400_000
export const MAX_XLSX_BYTES = 25 * 1024 * 1024
export const MAX_DOCX_TEXT_CHARS = 400_000
export const MAX_DOCX_PARAGRAPHS = 10_000
export const MAX_DOCX_BYTES = 25 * 1024 * 1024
export const MAX_PPTX_SLIDES = 200
export const MAX_PPTX_SLIDE_CHARS = 100_000
export const MAX_PPTX_TEXT_CHARS = 400_000
export const MAX_PPTX_BYTES = 25 * 1024 * 1024

export type XlsxCell = string | number | boolean | null

export type XlsxInput = Readonly<{
  readonly rows: ReadonlyArray<ReadonlyArray<XlsxCell>>
  readonly sheetName?: string
}>

export type PptxSlide = Readonly<{
  readonly title: string
  readonly body: string
}>

export type PptxInput = Readonly<{
  readonly slides: ReadonlyArray<PptxSlide>
}>

export class OfficeDocumentWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OfficeDocumentWriteError"
  }
}

/** Encode bounded Markdown-like text as a deterministic, portable DOCX. */
export const encodeDocx = (content: string): Uint8Array => {
  if (typeof content !== "string" || content.length > MAX_DOCX_TEXT_CHARS)
    throw new OfficeDocumentWriteError("DOCX content must be a bounded text string")
  validateXmlText(content, "document")
  const lines = content.split(/\r\n?|\n/)
  if (lines.length > MAX_DOCX_PARAGRAPHS)
    throw new OfficeDocumentWriteError(`DOCX is limited to ${MAX_DOCX_PARAGRAPHS} paragraphs`)
  let firstHeading = true
  const body = lines
    .map((line) => {
      const paragraph = docxLine(line, firstHeading)
      if (paragraph.heading) firstHeading = false
      return paragraph.xml
    })
    .join("")
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<w:body>${body}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/></w:sectPr></w:body></w:document>`
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>' +
    [
      [1, 32, 360, 240],
      [2, 28, 300, 180],
      [3, 24, 240, 120],
    ]
      .map(
        ([level, size, before, after]) =>
          `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`,
      )
      .join("") +
    '<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:qFormat/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="720" w:right="720"/></w:pPr></w:style>' +
    "</w:styles>"
  const entries = [
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>',
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ],
    [
      "word/_rels/document.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
    ],
    ["word/document.xml", documentXml],
    [
      "word/footer1.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>',
    ],
    [
      "word/settings.xml",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:updateFields w:val="true"/><w:compat/></w:settings>',
    ],
    ["word/styles.xml", stylesXml],
  ] as const
  const bytes = encodeZip(entries.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })))
  if (bytes.byteLength > MAX_DOCX_BYTES)
    throw new OfficeDocumentWriteError(`DOCX output exceeds the ${MAX_DOCX_BYTES}-byte limit`)
  return bytes
}

/** Encode a bounded title/body slide deck as deterministic OOXML. */
export const encodePptx = (input: PptxInput): Uint8Array => {
  const slides = normalizePptxSlides(input.slides)
  const slideIds = slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")
  const slideRelationships = slides
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
    )
    .join("")
  const contentOverrides = slides
    .map(
      (_, index) =>
        `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    )
    .join("")
  const presentationXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>`
  const entries = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${contentOverrides}</Types>`,
    ],
    [
      "_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>',
    ],
    ["ppt/presentation.xml", presentationXml],
    [
      "ppt/_rels/presentation.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slideRelationships}</Relationships>`,
    ],
    ["ppt/slideMasters/slideMaster1.xml", pptxSlideMasterXml()],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>',
    ],
    ["ppt/slideLayouts/slideLayout1.xml", pptxSlideLayoutXml()],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>',
    ],
    ["ppt/theme/theme1.xml", pptxThemeXml()],
    ...slides.flatMap((slide, index) => [
      [`ppt/slides/slide${index + 1}.xml`, pptxSlideXml(slide)],
      [
        `ppt/slides/_rels/slide${index + 1}.xml.rels`,
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>',
      ],
    ]),
  ] as const
  const bytes = encodeZip(entries.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })))
  if (bytes.byteLength > MAX_PPTX_BYTES)
    throw new OfficeDocumentWriteError(`PPTX output exceeds the ${MAX_PPTX_BYTES}-byte limit`)
  return bytes
}

/** Model-facing adapter for the legacy JSON slide shape. */
export const encodePptxJson = (content: string): Uint8Array => {
  if (typeof content !== "string" || content.length > 2_000_000)
    throw new OfficeDocumentWriteError("PPTX content must be a bounded JSON string")
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new OfficeDocumentWriteError("PPTX content is not valid JSON")
  }
  if (!Array.isArray(value)) throw new OfficeDocumentWriteError("PPTX content must contain an array")
  if (value.length === 0) throw new OfficeDocumentWriteError("PPTX content must contain at least one slide")
  const slides = value.map((item, index): PptxSlide => {
    if (typeof item === "string") return { title: `Slide ${index + 1}`, body: item }
    if (!isRecord(item)) throw new OfficeDocumentWriteError(`slide ${index + 1} must be a string or object`)
    return {
      title: item.title === undefined ? "" : normalizePptxField(item.title, `slide ${index + 1} title`),
      body: item.body === undefined ? "" : normalizePptxField(item.body, `slide ${index + 1} body`),
    }
  })
  return encodePptx({ slides })
}

const normalizePptxSlides = (slides: PptxInput["slides"]): ReadonlyArray<PptxSlide> => {
  if (!Array.isArray(slides)) throw new OfficeDocumentWriteError("slides must be an array")
  if (slides.length === 0) throw new OfficeDocumentWriteError("PPTX content must contain at least one slide")
  if (slides.length > MAX_PPTX_SLIDES)
    throw new OfficeDocumentWriteError(`PPTX is limited to ${MAX_PPTX_SLIDES} slides`)
  let total = 0
  return slides.map((slide, index) => {
    if (!slide || typeof slide !== "object") throw new OfficeDocumentWriteError(`slide ${index + 1} is invalid`)
    const title = normalizePptxField(slide.title, `slide ${index + 1} title`)
    const body = normalizePptxField(slide.body, `slide ${index + 1} body`)
    total += title.length + body.length
    if (total > MAX_PPTX_TEXT_CHARS)
      throw new OfficeDocumentWriteError(`PPTX text exceeds the ${MAX_PPTX_TEXT_CHARS}-character limit`)
    return { title, body }
  })
}

const normalizePptxField = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new OfficeDocumentWriteError(`${label} must be a string`)
  if (value.length > MAX_PPTX_SLIDE_CHARS)
    throw new OfficeDocumentWriteError(`${label} exceeds the ${MAX_PPTX_SLIDE_CHARS}-character limit`)
  validateXmlText(value, label)
  return value
}

const pptxSlideXml = (slide: PptxSlide): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
  pptxShape(2, "Title", 457200, 274638, 11125200, 1143000, slide.title, true) +
  pptxShape(3, "Content", 685800, 1600200, 10820400, 4572000, slide.body, false) +
  "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"

const pptxShape = (
  id: number,
  name: string,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  bold: boolean,
): string => {
  const size = bold ? 2800 : 2200
  const paragraphs = text
    .split(/\r\n?|\n/)
    .map(
      (line) =>
        `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="zh-CN" sz="${size}"${bold ? ' b="1"' : ""}/><a:t>${escapeXml(line)}</a:t></a:r><a:endParaRPr lang="zh-CN" sz="${size}"/></a:p>`,
    )
    .join("")
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
}

const pptxSlideMasterXml = (): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>'

const pptxSlideLayoutXml = (): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="titleAndObject" preserve="1"><p:cSld name="Title and Content"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

const pptxThemeXml = (): string =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>'

/** Encode a bounded table as a portable, metadata-free XLSX workbook. */
export const encodeXlsx = (input: XlsxInput): Uint8Array => {
  const rows = normalizeRows(input.rows)
  const sheetName = normalizeSheetName(input.sheetName)
  const sheet = sheetXml(rows)
  const entries = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXmlAttribute(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    ["xl/worksheets/sheet1.xml", sheet],
  ] as const
  const bytes = encodeZip(entries.map(([name, text]) => ({ name, data: Buffer.from(text, "utf8") })))
  if (bytes.byteLength > MAX_XLSX_BYTES)
    throw new OfficeDocumentWriteError(`XLSX output exceeds the ${MAX_XLSX_BYTES}-byte limit`)
  return bytes
}

/**
 * Model-facing adapter for the legacy JSON-row shape. Objects become a stable
 * header row in first-seen key order; arrays remain explicit table rows. JSON
 * parsing and shape validation stay here so the generic Core `write` tool can
 * keep one path while rejecting ambiguous payloads before mutation.
 */
export const encodeXlsxJson = (content: string, sheetName?: string): Uint8Array => {
  if (typeof content !== "string" || content.length > 2_000_000)
    throw new OfficeDocumentWriteError("XLSX content must be a bounded JSON string")
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new OfficeDocumentWriteError("XLSX content is not valid JSON")
  }
  if (!Array.isArray(value)) throw new OfficeDocumentWriteError("XLSX content must contain an array")
  if (value.length > MAX_XLSX_ROWS) throw new OfficeDocumentWriteError(`XLSX is limited to ${MAX_XLSX_ROWS} rows`)

  const rows: XlsxCell[][] =
    value.length > 0 && value.every((item) => isRecord(item))
      ? (() => {
          const headers: string[] = []
          for (const item of value) {
            for (const key of Object.keys(item)) if (!headers.includes(key)) headers.push(key)
          }
          return [
            headers,
            ...value.map((item) =>
              headers.map((key) =>
                normalizeJsonCell(Object.prototype.hasOwnProperty.call(item, key) ? item[key] : null),
              ),
            ),
          ]
        })()
      : value.map((item, index) => {
          if (!Array.isArray(item)) throw new OfficeDocumentWriteError(`row ${index + 1} must be an array`)
          return item.map(normalizeJsonCell)
        })
  return encodeXlsx({ rows, sheetName })
}

const docxLine = (rawLine: string, firstHeading: boolean): { readonly xml: string; readonly heading: boolean } => {
  const line = rawLine.trimEnd()
  const stripped = line.trim()
  if (stripped === "<!-- pagebreak -->" || stripped === "\\pagebreak" || stripped === "[PAGE BREAK]")
    return { xml: '<w:p><w:r><w:br w:type="page"/></w:r></w:p>', heading: false }

  const heading = stripped.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
  if (heading) {
    const title = cleanDocxInline(heading[2])
    const level = heading[1].length
    const style = level === 1 && firstHeading ? "Title" : `Heading${Math.min(level, 3)}`
    const toc = title.toLowerCase() === "目录" ? docxTocField() : ""
    return { xml: docxParagraph(title, style) + toc, heading: true }
  }

  const bullet = stripped.match(/^[-*+]\s+(.+)$/)
  if (bullet) return { xml: docxParagraph(`• ${cleanDocxInline(bullet[1])}`, "Normal", 360), heading: false }

  const numbered = stripped.match(/^(\d+[.)、])\s*(.+)$/)
  if (numbered)
    return { xml: docxParagraph(`${numbered[1]} ${cleanDocxInline(numbered[2])}`, "Normal", 360), heading: false }

  if (stripped.startsWith(">"))
    return { xml: docxParagraph(cleanDocxInline(stripped.slice(1).trim()), "Quote"), heading: false }

  return { xml: docxParagraph(cleanDocxInline(stripped)), heading: false }
}

const cleanDocxInline = (text: string): string =>
  text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/`/g, "")
    .trim()

const docxParagraph = (text: string, style: string = "Normal", indent = 0): string => {
  const indentation = indent > 0 ? `<w:ind w:left="${indent}" w:hanging="360"/>` : ""
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${indentation}</w:pPr><w:r><w:rPr><w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
}

const docxTocField = (): string =>
  '<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'

const normalizeRows = (rows: XlsxInput["rows"]): ReadonlyArray<ReadonlyArray<XlsxCell>> => {
  if (!Array.isArray(rows)) throw new OfficeDocumentWriteError("rows must be an array")
  if (rows.length > MAX_XLSX_ROWS) throw new OfficeDocumentWriteError(`XLSX is limited to ${MAX_XLSX_ROWS} rows`)
  let textChars = 0
  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new OfficeDocumentWriteError(`row ${rowIndex + 1} must be an array`)
    if (row.length > MAX_XLSX_COLUMNS)
      throw new OfficeDocumentWriteError(`row ${rowIndex + 1} exceeds ${MAX_XLSX_COLUMNS} columns`)
    return row.map((cell, columnIndex) => {
      if (cell === null) return null
      if (typeof cell === "boolean") return cell
      if (typeof cell === "number") {
        if (!Number.isFinite(cell))
          throw new OfficeDocumentWriteError(`cell ${cellReference(rowIndex, columnIndex)} must be finite`)
        return cell
      }
      if (typeof cell !== "string")
        throw new OfficeDocumentWriteError(`cell ${cellReference(rowIndex, columnIndex)} has an unsupported type`)
      if (cell.length > MAX_XLSX_CELL_CHARS)
        throw new OfficeDocumentWriteError(
          `cell ${cellReference(rowIndex, columnIndex)} exceeds the ${MAX_XLSX_CELL_CHARS}-character limit`,
        )
      validateXmlText(cell, cellReference(rowIndex, columnIndex))
      textChars += cell.length
      if (textChars > MAX_XLSX_TEXT_CHARS)
        throw new OfficeDocumentWriteError(`XLSX text exceeds the ${MAX_XLSX_TEXT_CHARS}-character limit`)
      return cell
    })
  })
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const normalizeJsonCell = (value: unknown): XlsxCell => {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number")
    return value
  throw new OfficeDocumentWriteError("XLSX cells must be strings, numbers, booleans, or null")
}

const normalizeSheetName = (value: XlsxInput["sheetName"]): string => {
  const name = String(value ?? "Sheet1").trim() || "Sheet1"
  if (name.length > 31 || /[\\/*?:\[\]]/.test(name) || [...name].some((char) => char < " "))
    throw new OfficeDocumentWriteError("sheetName is invalid")
  validateXmlText(name, "sheetName")
  return name
}

const sheetXml = (rows: ReadonlyArray<ReadonlyArray<XlsxCell>>): string => {
  const body = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((cell, columnIndex) => cellXml(cellReference(rowIndex, columnIndex), cell))
          .join("")}</row>`,
    )
    .join("")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`
}

const cellXml = (reference: string, value: XlsxCell): string => {
  if (value === null) return `<c r="${reference}"/>`
  if (typeof value === "boolean") return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`
  if (typeof value === "number") return `<c r="${reference}"><v>${String(value)}</v></c>`
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`
}

const cellReference = (rowIndex: number, columnIndex: number): string => {
  let value = columnIndex + 1
  let column = ""
  while (value > 0) {
    value -= 1
    column = String.fromCharCode(65 + (value % 26)) + column
    value = Math.floor(value / 26)
  }
  return `${column}${rowIndex + 1}`
}

const escapeXml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      default:
        return "&apos;"
    }
  })

const escapeXmlAttribute = (value: string) => escapeXml(value)

const validateXmlText = (value: string, reference: string): void => {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    const valid =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
      (codePoint >= 0x10000 && codePoint <= 0x10ffff)
    if (!valid) throw new OfficeDocumentWriteError(`cell ${reference} contains an invalid XML character`)
  }
}

type ZipInput = Readonly<{ name: string; data: Buffer }>

const encodeZip = (input: ReadonlyArray<ZipInput>): Uint8Array => {
  const entries = [...input].toSorted((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const seen = new Set<string>()
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    if (seen.has(entry.name)) throw new OfficeDocumentWriteError(`duplicate XLSX entry: ${entry.name}`)
    seen.add(entry.name)
    const name = Buffer.from(entry.name, "utf8")
    const compressed = deflateRawSync(entry.data)
    const checksum = crc32(entry.data)
    const header = Buffer.alloc(30 + name.byteLength)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(8, 8)
    header.writeUInt32LE(checksum, 14)
    header.writeUInt32LE(compressed.byteLength, 18)
    header.writeUInt32LE(entry.data.byteLength, 22)
    header.writeUInt16LE(name.byteLength, 26)
    name.copy(header, 30)
    local.push(header, compressed)

    const directory = Buffer.alloc(46 + name.byteLength)
    directory.writeUInt32LE(0x02014b50, 0)
    directory.writeUInt16LE(20, 4)
    directory.writeUInt16LE(20, 6)
    directory.writeUInt16LE(8, 10)
    directory.writeUInt32LE(checksum, 16)
    directory.writeUInt32LE(compressed.byteLength, 20)
    directory.writeUInt32LE(entry.data.byteLength, 24)
    directory.writeUInt16LE(name.byteLength, 28)
    directory.writeUInt32LE(offset, 42)
    name.copy(directory, 46)
    central.push(directory)
    offset += header.byteLength + compressed.byteLength
  }

  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
