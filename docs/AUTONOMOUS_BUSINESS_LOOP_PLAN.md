# Boucle autonome de test business sur StarNet

Spécification technique reçue de l'auteur (audit externe), transcrite ici telle quelle pour
transmission au développeur. Date de l'audit : 2026-09-13. Base de code : `adrien426/starnet`,
branche `feat/harness-backend`, licence MIT.

Trois agents en boucle : un scout qui détecte les opportunités monétisables, un orchestrateur qui
crée et supprime des agents business pour les tester, une mesure de revenu réel qui arbitre.

## 1 · Ce qui existe déjà dans le code

Ne pas réécrire ces briques, elles sont fonctionnelles et testées. Les réutiliser telles quelles.
Chemins vérifiés contre trunk au moment de l'écriture de ce doc — comme pour tout doc de ce
dossier, re-grep avant d'agir si le code a bougé depuis.

| Brique | Où | État |
|---|---|---|
| Scout d'opportunités | `shared/specialties.js` → spécialité `opportunist` / "Opportunity Finder" | Prêt à l'emploi |
| Passage d'infos entre agents | `team.dispatch`, transcripts, notebook persistant | Prêt à l'emploi |
| Création d'agents par un agent | `shared/events.js:126-127` (flux `summonAgent`), `frontend/app/world.js:8017` `spawnAgent()` | Prêt à l'emploi |
| Suppression d'agents | `frontend/app/app.js:614` `deleteAgent()` | Prêt à l'emploi |
| Exécution planifiée sans surveillance | `sidecar/cron-driver.js` (+ `sidecar/cron-store.js`, `sidecar/cron-guard.js`) avec `approvalMode:'full'` et `unattendedGrants` | Existe, à configurer |
| Génération d'images et de fiches produit | skill `image_generate` (`sidecar/tools/builtin/image.js`), intégrations print-on-demand | Prêt, clé API requise |

Note sur les grants non-surveillés : la whitelist qui autorise un mode non-surveillé est fermée par
design — `GRANTABLE_UNATTENDED = new Set(['workbench', 'connectors'])` dans
`sidecar/inputpolicy.js:67`, appliquée à chaque run (`sidecar/cron-store.js`). C'est la porte
évoquée en section 2.

## 2 · Ce qui manque et qu'il faut écrire

C'est l'intégralité du travail. Le doc interne de l'auteur (`docs/GROWTH_LOOP_PLAN.md`) le confirme :
« every store exists and is honest; the connective tissue is missing ».

### 🔴 BLOQUANT — Le connecteur de mesure de revenu

Rien dans le code ne lit un revenu réel. Pas de webhook Stripe, pas de lecture des ventes Etsy ou
Shopify, aucun analytics. C'est environ 80 % du travail restant et c'est entièrement à écrire.

**À livrer** : endpoint webhook → table `revenue_events` → méthode de lecture exposée à
l'orchestrateur.

### 🔴 BLOQUANT — Le mur de la publication

`GRANTABLE_UNATTENDED = ['workbench', 'connectors']` — seules deux capacités passent en mode
non-surveillé. Chaque manuel de spécialité impose « You draft; the Commander publishes ». La
publication et l'encaissement sont verrouillés sur validation humaine par design.

**À livrer** : connecteurs de publication custom, plus élargissement explicite de la liste des
grants non-surveillés.

### 🟠 IMPORTANT — La boucle d'apprentissage

Aucun mécanisme ne transforme le travail effectué en apprentissage. L'orchestrateur ne saura pas
que le test n°3 a mieux marché que le n°7 sans câblage explicite de la mesure vers la décision.

**À livrer** : agrégation par agent business, seuils de décision codés en dur côté code et non
côté prompt.

## 3 · Architecture cible

```
┌─────────────────────────────┐
│ AGENT 1 · Scout             │  opportunity finder (existant)
│ web_search, sizing demande  │  → écrit un rapport scoré
└──────────────┬──────────────┘
               │ team.dispatch (existant)
               ▼
┌─────────────────────────────┐
│ AGENT 2 · Orchestrateur      │  spawnAgent / deleteAgent (existant)
│ crée, teste, tue             │  → arbitre sur seuils codés
└──────────────┬──────────────┘
               │ spawn
               ▼
┌─────────────────────────────┐
│ AGENTS BUSINESS (N)          │  génèrent, préparent, publient
│ un par hypothèse testée      │
└──────────────┬──────────────┘
               │ vente réelle
               ▼
┌─────────────────────────────┐
│ MESURE  ◀── À ÉCRIRE ──▶     │  webhook Stripe / API Etsy
│ revenue_events                │
└──────────────┬──────────────┘
               │
               └──────────────▶ remonte vers AGENT 2
```

Le point critique : la flèche qui remonte du revenu réel vers l'orchestrateur. Sans elle, l'agent 2
supprime des agents sur une impression du modèle, pas sur une donnée. C'est la différence entre une
boucle et un générateur de bruit.

## 4 · Schéma de la table de mesure

Une seule table suffit pour démarrer. Alimentée par webhook, lue par l'orchestrateur à chaque tick
de cron.

```
revenue_events
  id             uuid       pk
  agent_id       text       fk → agent business testé
  hypothesis     text       la niche / l'angle testé
  source         text       stripe | etsy | shopify | gumroad
  revenue_cents  integer    montant encaissé, net
  cost_cents     integer    API + frais plateforme imputés
  occurred_at    timestamp
  raw            jsonb      payload brut du webhook

  index (agent_id, occurred_at)
```

Règle d'arbitrage à coder en dur, pas à confier au modèle : un agent business est supprimé si
`revenue_cents = 0` après N jours ou si `cost_cents > revenue_cents × 2`. Le LLM propose, le code
décide.

## 5 · Ordre de construction

| Période | Travail |
|---|---|
| Semaine 1–2 | Fork, clé API, faire tourner l'existant entièrement à la main. Aucun code écrit. Objectif : comprendre le dispatch et les transcripts avant de toucher quoi que ce soit. |
| Semaine 3–4 | Écrire le connecteur de mesure. Un vrai chiffre de vente atterrit en base. Rien d'autre ne compte avant ça. |
| Semaine 5–6 | Brancher l'orchestrateur sur la table. Décisions garder/tuer sur donnée réelle et seuils en dur, pas sur jugement du modèle. |
| Semaine 7+ | Activer le cron non-surveillé, budget API plafonné, alerte sur dépassement. Surveiller les premières semaines. |

## 6 · Contraintes à ne pas ignorer

**Version pré-release** — v0.10.13, 9 400 fichiers largement générés par agents. Ne jamais laisser
tourner sans plafond de dépense.

**Le modèle n'est pas une source de vérité marché** — le scout fait du `web_search` plus du
jugement LLM. Aucune donnée marché réelle. Son propre manuel interdit d'inventer une taille de
marché.

**Coût de fonctionnement** — compter 50 à 200 €/mois d'API pour une boucle qui tourne, hors frais
de plateforme, avant le premier euro encaissé.

**Conformité images IA** — Etsy et Amazon imposent des règles de divulgation. Selon la juridiction,
une image générée peut ne pas être protégeable par copyright.

**Le goulot est l'audience** — la boucle teste vite et jette vite. Elle ne fabrique aucune demande.
Sans canal de distribution préexistant, le rendement est nul.

## Verdict à communiquer au développeur

La boucle est faisable et le socle est sérieux — dispatch multi-agents réel, chemin cron
non-surveillé existant, suite de tests conséquente. Mais StarNet accélère la **production**, jamais
la **distribution**. Une boucle qui génère et publie sur un canal sans audience produit des zéros
très efficacement. Le connecteur de mesure et le canal d'acquisition sont les deux seules choses
qui déterminent si ça gagne de l'argent.
