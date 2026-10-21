import {
  faAnglesRight,
  faArrowLeft,
  faArrowRightLong,
  faArrowRotateLeft,
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faBold,
  faBuilding,
  faCheck,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleExclamation,
  faCircleInfo,
  faClockRotateLeft,
  faDownload,
  faEllipsisVertical,
  faEye,
  faEyeSlash,
  faFile,
  faFloppyDisk,
  faGear,
  faHouse,
  faImage,
  faItalic,
  faLink,
  faListOl,
  faListUl,
  faMagnifyingGlass,
  faPen,
  faPlus,
  faRightFromBracket,
  faTrash,
  faTriangleExclamation,
  faUnderline,
  faUpload,
  faXmark,
} from '@fortawesome/free-solid-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

// FontAwesome's own `byPrefixAndName.fas['icon-name']` lookup ships only from a paid
// Kit package (`@awesome.me/kit-<code>/icons`) — not available from the free npm
// packages. This mirrors that exact lookup shape over the free Solid set, so every
// call site uses the same syntax with no Kit subscription.
//
// Only the icons listed here are in the lookup: importing the whole `fas` set put
// ~950 KB of SVG paths into every ERP page's JavaScript. An icon a call site needs
// must be added to this list (or registered with `registerIcons`); a name missing
// from it resolves to undefined. Module tile icons (`module.json` `menu_icon`) are
// arbitrary names, so they are resolved on the server instead (`solidIcon`, server
// barrel) and only their definitions reach the browser.
const BUILT_IN: IconDefinition[] = [
  faAnglesRight,
  faArrowLeft,
  faArrowRightLong,
  faArrowRotateLeft,
  faArrowUpRightFromSquare,
  faBars,
  faBell,
  faBold,
  faBuilding,
  faCheck,
  faChevronDown,
  faChevronLeft,
  faChevronRight,
  faCircleExclamation,
  faCircleInfo,
  faClockRotateLeft,
  faDownload,
  faEllipsisVertical,
  faEye,
  faEyeSlash,
  faFile,
  faFloppyDisk,
  faGear,
  faHouse,
  faImage,
  faItalic,
  faLink,
  faListOl,
  faListUl,
  faMagnifyingGlass,
  faPen,
  faPlus,
  faRightFromBracket,
  faTrash,
  faTriangleExclamation,
  faUnderline,
  faUpload,
  faXmark,
]

export const byPrefixAndName = {
  fas: Object.fromEntries(BUILT_IN.map((def) => [def.iconName, def])) as Record<
    string,
    IconDefinition
  >,
}

/** Adds solid icons to `byPrefixAndName.fas` — for a module whose own UI looks
 * icons up by name. Importing the definition and passing it to `FontAwesomeIcon`
 * directly works too and needs no registration. */
export function registerIcons(...defs: IconDefinition[]): void {
  for (const def of defs) byPrefixAndName.fas[def.iconName] = def
}

export type { IconDefinition }
export { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
