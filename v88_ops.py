"""v88 : réglage du rendu de la toile (moteur, image nette pendant le geste, temps du dernier rendu)."""
import json, sys
BAR = "position:absolute;left:4px;top:50%;width:3px;height:14px;margin-top:-7px;background:var(--sc-primary);border-radius:2px;pointer-events:none"
LABEL = "display:block;font-size:var(--sc-label-fs,.875rem);font-weight:var(--sc-label-fw,500);line-height:1.2;margin-bottom:.22em"
MODES = [("auto", "Automatique", "Carte graphique si possible"),
         ("gpu", "Carte graphique", "Dans un fil à part (WebGL)"),
         ("cpu", "Processeur", "Dans un fil à part, sans carte graphique"),
         ("direct", "Direct", "Sur le fil principal (ancien rendu)")]

def item(mode, lib, hint):
    return {"tagName": "div", "attributes": {"style": "position:relative"}, "nodes": [
        {"tagName": "sonic-action", "attributes": {"payload": json.dumps({"mode": mode, "modeLib": lib}, ensure_ascii=False), "target": "rendu", "trigger": "click", "type": "set"}, "nodes": [
            {"tagName": "sonic-menu-item", "attributes": {"size": "sm", "style": "width:100%;justify-content:flex-start;padding-left:14px;flex-direction:column;align-items:flex-start;gap:0", "variant": "ghost"}, "nodes": [
                {"tagName": "span", "textContent": lib},
                {"tagName": "span", "attributes": {"style": "font-size:11px;opacity:.6;white-space:normal;text-align:left"}, "textContent": hint}]}]},
        {"tagName": "sonic-if", "attributes": {"dataProvider": "rendu", "key": "mode", "equals": mode}, "nodes": [{"tagName": "div", "attributes": {"style": BAR}}]}]}

def engine(eq, txt):
    return {"tagName": "sonic-if", "attributes": {"dataProvider": "etat.render", "key": "engine", "equals": eq}, "nodes": [{"tagName": "span", "textContent": txt}]}

def panel():
    return {"tagName": "div", "attributes": {"slot": "content", "style": "padding:10px 12px;width:250px;box-sizing:border-box"}, "nodes": [
        {"tagName": "sonic-fieldset", "attributes": {"variant": "ghost", "tight": "", "label": "Rendu de la toile"}, "nodes": [
            {"tagName": "sonic-form-layout", "nodes": [
                {"tagName": "div", "attributes": {"class": "form-item-container"}, "nodes": [
                    {"tagName": "span", "attributes": {"style": LABEL}, "textContent": "Moteur"},
                    {"tagName": "sonic-pop", "attributes": {"placement": "bottom-start", "style": "display:block"}, "nodes": [
                        {"tagName": "sonic-button", "attributes": {"aria-label": "Moteur de rendu", "style": "width:100%", "align": "left", "shape": "block"}, "nodes": [
                            {"tagName": "sonic-value", "attributes": {"dataProvider": "rendu", "key": "modeLib", "style": "white-space:nowrap"}},
                            {"tagName": "sonic-icon", "attributes": {"library": "iconoir", "name": "nav-arrow-down", "size": "sm", "slot": "suffix"}}]},
                        {"tagName": "sonic-menu", "attributes": {"slot": "content", "style": "display:flex;flex-direction:column;gap:0;padding:6px;width:226px"}, "nodes": [item(*m) for m in MODES]}]}]},
                {"tagName": "div", "attributes": {"class": "form-item-container"}, "nodes": [
                    {"tagName": "label", "attributes": {"style": "display:flex;align-items:center;gap:8px;cursor:pointer"}, "nodes": [
                        {"tagName": "sonic-checkbox", "attributes": {"formDataProvider": "rendu", "name": "live", "size": "sm", "unique": "", "value": "oui"}},
                        {"tagName": "span", "attributes": {"style": "font-size:13px"}, "textContent": "Image nette pendant le geste"}]},
                    {"tagName": "span", "attributes": {"style": "display:block;font-size:11px;opacity:.6;margin-top:4px"}, "textContent": "Avec la carte graphique : la vue se précise pendant le zoom. Plus gourmand."}]},
                {"tagName": "div", "attributes": {"class": "form-item-container"}, "nodes": [
                    {"tagName": "div", "attributes": {"style": "font-size:12px;opacity:.75;display:flex;flex-wrap:wrap;gap:4px"}, "nodes": [
                        {"tagName": "span", "textContent": "Dernier rendu :"},
                        {"tagName": "sonic-value", "attributes": {"dataProvider": "etat.render", "key": "ms"}},
                        {"tagName": "span", "textContent": "ms ·"},
                        engine("gl", "carte graphique"), engine("2d", "processeur"), engine("direct", "fil principal")]}]}]}]}]}

def pop(placement):
    return {"tagName": "sonic-pop", "attributes": {"placement": placement}, "nodes": [
        {"tagName": "sonic-button", "attributes": {"aria-label": "Rendu de la toile", "icon": "", "shape": "square", "size": "sm", "variant": "ghost"}, "nodes": [
            {"tagName": "sonic-icon", "attributes": {"library": "iconoir", "name": "cpu"}}]},
        panel()]}

src = json.load(open(sys.argv[1])); D = src.get("document", src)
SK = "/views/0/root/nodes/0/nodes/7/nodes/0/nodes/0/nodes/0"
def at(path):
    n = D
    for k in path.strip("/").split("/"): n = n[int(k)] if isinstance(n, list) else n[k]
    return n
sk = at(SK)
assert sk["tagName"] == "sonic-sketch"
prefs = sk["attributes"]["prefs-from"]
assert at("/views/0/root/nodes/0/nodes/12/nodes/0/nodes/2/nodes/4")["attributes"]["label"] == "Plein écran"
assert at("/views/0/root/nodes/0/nodes/13/nodes/0/nodes/0/nodes/5")["attributes"]["id"] == "pleinEcranM"
ops = [
    {"op": "add", "path": "/data/stores/rendu", "value": {"budgetMs": 30, "initial": {"mode": "auto", "modeLib": "Automatique", "live": "non"},
        "reducer": "$action.type = 'set' ? $merge([$state, $action.payload]) : $state"}},
    {"op": "add", "path": SK + "/attributes/render-from", "value": "rendu"},
    {"op": "replace", "path": SK + "/attributes/prefs-from", "value": prefs + " rendu"},
    # mobile d'abord (indices indépendants du bureau)
    {"op": "add", "path": "/views/0/root/nodes/0/nodes/13/nodes/0/nodes/0/nodes/5", "value": pop("bottom-end")},
    {"op": "add", "path": "/views/0/root/nodes/0/nodes/12/nodes/0/nodes/2/nodes/4", "value": pop("top-end")},
]
json.dump(ops, open(sys.argv[2], "w"), ensure_ascii=False)
print(len(ops), "ops")
