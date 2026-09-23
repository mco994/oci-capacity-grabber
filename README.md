# oci-capacity-grabber

Attrape une fenetre de capacite ARM sur Oracle Cloud (Marseille, AD unique) pour recreer la VM `claude-dev`.

## Cible actuelle (2026-09-23)

- **2 OCPU / 12 Go**, `VM.Standard.A1.Flex` — c'est le **plafond du compte** : mesure faite a l'API, `standard-a1-core-count` = 2 et `standard-a1-memory-count` = 12. Au-dela, la reponse n'est plus « out of capacity » mais `LimitExceeded`. (L'allocation d'origine, 4 OCPU / 24 Go, a ete divisee par deux a la fin du free trial.)
- **Demarrage sur le disque existant** (`sourceType: bootVolume`), pas sur une image : le disque de l'ancienne VM (150 Go, cree le 2026-06-26) a survecu a la suppression de l'instance et contient tout l'environnement. Relancer dessus = VM utilisable immediatement, sans bootstrap.
- Le stockage Always Free est plafonne a 200 Go : ce disque de 150 Go + un eventuel micro x86 de 50 Go saturent le quota. Ne pas creer de second disque de 150 Go, ce serait refuse.

## Etat

- Compte `mconan`, region de rattachement **Marseille**, tenancy **ACTIVE** (verifie le 2026-09-23). Aucune instance.
- Seul blocage : **capacite hote**. Les lancements sont autorises, ils echouent sur `Out of host capacity`.
- Marseille n'a **qu'un seul domaine de disponibilite** : pas d'AD de repli, et le Free Tier est lie a la region de rattachement — changer de region n'est pas une option.

## Fonctionnement

`launch.js` = signeur OCI minimal sans SDK. Il verifie qu'aucune instance `claude-dev` ne tourne, puis POSTe LaunchInstance en boucle toutes les 30 s pendant 340 min par run. Le workflow `grab.yml` (cron `*/5`) relance en continu ; GitHub bride les crons a environ un run par heure, d'ou la boucle interne.

Codes de sortie : succes ou erreur -> `exit 1` (GitHub envoie un mail « run failed », c'est le signal de **reussite**) ; pas de capacite -> `exit 0` silencieux.

## Quand la VM tombe

1. Desactiver le workflow (`gh workflow disable grab-arm-capacity --repo mco994/oci-capacity-grabber`).
2. Recuperer l'IP publique, verifier que Tailscale remonte (la cle du noeud peut avoir expire apres six mois).
3. Verifier la session `tmux dev` recreee par le cron `@reboot`.

## Fichiers

- `launch.js` — grabber A1 (la cible ci-dessus).
- `launch-micro.js` / `micro-ip.js` — variante E2.1.Micro x86, si on veut un hote toujours allume pour sonder plus vite que GitHub.
- `systemd/` — service + watchdog pour faire tourner le grabber depuis ce micro hote.
