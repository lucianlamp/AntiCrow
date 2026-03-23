import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import ja from "./ja.json";
import en from "./en.json";

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            ja: { translation: ja },
            en: { translation: en },
        },
        fallbackLng: "ja",
        interpolation: {
            escapeValue: false,
        },
        detection: {
            order: ["querystring", "navigator", "htmlTag"],
            lookupQuerystring: "lang",
        },
    });

export default i18n;
