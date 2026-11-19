package office

import (
	"archive/zip"
	"bytes"
	"fmt"
	"sort"
)

const packageRelations = `http://schemas.openxmlformats.org/package/2006/relationships`
const officeRelations = `http://schemas.openxmlformats.org/officeDocument/2006/relationships`

func relationships(entries string) string {
	return `<Relationships xmlns="` + packageRelations + `">` + entries + `</Relationships>`
}
func relationship(id, kind, target string) string {
	return `<Relationship Id="` + id + `" Type="` + officeRelations + `/` + kind + `" Target="` + target + `"/>`
}

// Blank creates small, valid Open XML packages, never an empty file with an
// Office extension. Templates are application-owned and contain no macros.
func Blank(kind string) ([]byte, string, error) {
	files := map[string]string{}
	var mime string
	var overrides string
	switch kind {
	case "docx":
		mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
		files["_rels/.rels"] = relationships(relationship("rId1", "officeDocument", "word/document.xml"))
		files["word/document.xml"] = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`
		overrides = `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
	case "xlsx":
		mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
		files["_rels/.rels"] = relationships(relationship("rId1", "officeDocument", "xl/workbook.xml"))
		files["xl/workbook.xml"] = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="` + officeRelations + `"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
		files["xl/_rels/workbook.xml.rels"] = relationships(relationship("rId1", "worksheet", "worksheets/sheet1.xml"))
		files["xl/worksheets/sheet1.xml"] = `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`
		overrides = `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
	case "pptx":
		mime = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
		files["_rels/.rels"] = relationships(relationship("rId1", "officeDocument", "ppt/presentation.xml"))
		ns := ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="` + officeRelations + `" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`
		shapeTree := `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>`
		files["ppt/presentation.xml"] = `<p:presentation` + ns + `><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
		files["ppt/_rels/presentation.xml.rels"] = relationships(relationship("rId1", "slideMaster", "slideMasters/slideMaster1.xml") + relationship("rId2", "slide", "slides/slide1.xml"))
		files["ppt/slides/slide1.xml"] = `<p:sld` + ns + `><p:cSld>` + shapeTree + `</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
		files["ppt/slides/_rels/slide1.xml.rels"] = relationships(relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"))
		files["ppt/slideLayouts/slideLayout1.xml"] = `<p:sldLayout` + ns + ` type="blank" preserve="1"><p:cSld name="Blank">` + shapeTree + `</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`
		files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = relationships(relationship("rId1", "slideMaster", "../slideMasters/slideMaster1.xml"))
		files["ppt/slideMasters/slideMaster1.xml"] = `<p:sldMaster` + ns + `><p:cSld>` + shapeTree + `</p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`
		files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = relationships(relationship("rId1", "slideLayout", "../slideLayouts/slideLayout1.xml") + relationship("rId2", "theme", "../theme/theme1.xml"))
		// A slide master needs its own complete DrawingML theme. XML-valid
		// packages without it can convert but fail inside the presentation editor.
		var colors string
		for _, color := range []struct{ name, hex string }{
			{"dk1", "172033"}, {"lt1", "FFFFFF"}, {"dk2", "334155"}, {"lt2", "F1F5F9"},
			{"accent1", "4F46E5"}, {"accent2", "059669"}, {"accent3", "D97706"},
			{"accent4", "E11D48"}, {"accent5", "0284C7"}, {"accent6", "7C3AED"},
			{"hlink", "2563EB"}, {"folHlink", "7C3AED"},
		} {
			colors += `<a:` + color.name + `><a:srgbClr val="` + color.hex + `"/></a:` + color.name + `>`
		}
		font := `<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>`
		fill := `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`
		line := `<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr">` + fill + `<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`
		effect := `<a:effectStyle><a:effectLst/></a:effectStyle>`
		files["ppt/theme/theme1.xml"] = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="EERP"><a:themeElements><a:clrScheme name="EERP">` + colors + `</a:clrScheme><a:fontScheme name="EERP"><a:majorFont>` + font + `</a:majorFont><a:minorFont>` + font + `</a:minorFont></a:fontScheme><a:fmtScheme name="EERP"><a:fillStyleLst>` + fill + fill + fill + `</a:fillStyleLst><a:lnStyleLst>` + line + line + line + `</a:lnStyleLst><a:effectStyleLst>` + effect + effect + effect + `</a:effectStyleLst><a:bgFillStyleLst>` + fill + fill + fill + `</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`
		overrides += `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`
		for _, part := range []struct{ path, contentType string }{
			{"presentation.xml", "presentation.main"}, {"slides/slide1.xml", "slide"}, {"slideLayouts/slideLayout1.xml", "slideLayout"}, {"slideMasters/slideMaster1.xml", "slideMaster"},
		} {
			overrides += `<Override PartName="/ppt/` + part.path + `" ContentType="application/vnd.openxmlformats-officedocument.presentationml.` + part.contentType + `+xml"/>`
		}
	default:
		return nil, "", fmt.Errorf("office: unsupported template")
	}
	files["[Content_Types].xml"] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` + overrides + `</Types>`
	var data bytes.Buffer
	archive := zip.NewWriter(&data)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		writer, err := archive.Create(name)
		if err != nil {
			return nil, "", err
		}
		if _, err := writer.Write([]byte(files[name])); err != nil {
			return nil, "", err
		}
	}
	if err := archive.Close(); err != nil {
		return nil, "", err
	}
	return data.Bytes(), mime, nil
}
