import { languages } from "@excalidraw/excalidraw";

/* Excalidraw only offers locales that are at least 85% translated, and the
   bundled Thai file sits at 44%, so `langCode="th-TH"` would fall back to
   English. The component resolves the code through this exact array, so the
   entry has to exist here before the editor mounts; the locale chunk itself is
   already in the package and loads on demand. */
export const LANG_CODE = "th-TH";

if (!languages.some((lang) => lang.code === LANG_CODE)) {
  languages.push({ code: LANG_CODE, label: "ไทย" });
}
