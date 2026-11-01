/** Feuilles de style importées en texte (Vite `?inline`), injectées dans un shadow root. */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
