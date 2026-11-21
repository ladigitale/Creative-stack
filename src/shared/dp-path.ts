import { PublisherManager } from "@supersoniks/concorde/utils";
import { dp } from "@supersoniks/concorde/core/utils/PublisherProxy";

/**
 * Publisher d'un DataProvider désigné par un attribut (`dataProvider`, `*-provider`, `out-data-provider`…).
 *
 * Un nom pointé (`carte.points`) désigne la clé `points` du DataProvider `carte` : `dp()` suit ce chemin, alors que
 * `PublisherManager.get` le prendrait pour le nom d'un autre DataProvider, jamais alimenté. Un nom simple garde
 * l'instance de `PublisherManager.get`.
 */
export function publisherAt(id: string): ReturnType<typeof PublisherManager.get> {
  return (id.includes(".") ? dp(id) : PublisherManager.get(id)) as ReturnType<typeof PublisherManager.get>;
}
