import HTML from "@supersoniks/concorde/core/utils/HTML";
import { asset } from "./asset";
import {
  formParams,
  type FormBindHost,
  type FormOrbit,
} from "./form-params";

export type { FormBindHost, FormOrbit };

function resolveFormProviderId(
  el: HTMLElement,
  dataProvider: string,
): string {
  const own = dataProvider?.trim();
  if (own) return own;
  return (
    HTML.getAncestorAttributeValue(el, "dataProvider") ||
    HTML.getAncestorAttributeValue(el, "formDataProvider") ||
    ""
  );
}

function resolveOutProviderId(
  el: HTMLElement,
  outDataProvider: string,
  dataProvider: string,
): string {
  const own = outDataProvider?.trim();
  if (own) return own;
  return resolveFormProviderId(el, dataProvider);
}

/** Form DP resolve + apply. Paths: `formBind.asset.*`, `formBind.formParams.*`. */
export const formBind = {
  resolveFormProviderId,
  resolveOutProviderId,
  asset,
  formParams,
} as const;
