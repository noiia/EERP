import { FontAwesomeIcon } from '@eerp/core-front'
import { faFolder } from '@fortawesome/free-solid-svg-icons'
import csv from './file-icons/csv.svg'
import doc from './file-icons/doc.svg'
import docx from './file-icons/docx.svg'
import epub from './file-icons/epub.svg'
import html from './file-icons/html.svg'
import jpg from './file-icons/jpg.svg'
import md from './file-icons/md.svg'
import neutral from './file-icons/neutral.svg'
import odp from './file-icons/odp.svg'
import ods from './file-icons/ods.svg'
import odt from './file-icons/odt.svg'
import pdf from './file-icons/pdf.svg'
import png from './file-icons/png.svg'
import ppt from './file-icons/ppt.svg'
import pptx from './file-icons/pptx.svg'
import rtf from './file-icons/rtf.svg'
import svg from './file-icons/svg.svg'
import txt from './file-icons/txt.svg'
import vsdx from './file-icons/vsdx.svg'
import xls from './file-icons/xls.svg'
import xlsx from './file-icons/xlsx.svg'
import xml from './file-icons/xml.svg'

// Next imports an SVG as { src }, Vite (tests) as the URL string.
type Asset = string | { src: string }
const icons: Record<string, Asset> = {
  csv,
  doc,
  docx,
  epub,
  html,
  jpg,
  md,
  odp,
  ods,
  odt,
  pdf,
  png,
  ppt,
  pptx,
  rtf,
  svg,
  txt,
  vsdx,
  xls,
  xlsx,
  xml,
  jpeg: jpg,
  gif: png,
  webp: png,
  bmp: png,
  htm: html,
  docm: docx,
  dotx: docx,
  xlsm: xlsx,
  xltx: xlsx,
  pptm: pptx,
  potx: pptx,
  ppsx: pptx,
}

/** The Euro-Office format icon of a file name ("neutral" for unknown extensions). */
export const fileIconSrc = (name: string) => {
  const dot = name.lastIndexOf('.')
  const a = (dot > 0 && icons[name.slice(dot + 1).toLowerCase()]) || neutral
  return typeof a === 'string' ? a : a.src
}

export function FileIcon({ name, folder = false }: { name: string; folder?: boolean }) {
  if (folder)
    return (
      <FontAwesomeIcon
        icon={faFolder}
        fixedWidth
        style={{ color: '#E8B54A', fontSize: 18, flexShrink: 0 }}
        aria-hidden
      />
    )
  return (
    <img
      src={fileIconSrc(name)}
      alt=""
      aria-hidden
      width={16}
      height={20}
      style={{ flexShrink: 0 }}
    />
  )
}
