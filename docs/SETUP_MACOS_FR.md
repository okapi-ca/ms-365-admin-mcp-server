# MS 365 Admin MCP — Guide d'installation macOS

Connecte Claude Desktop sur ton Mac au serveur MCP `ms-365-admin` LCI pour interroger les données M365 sécurité, audit, utilisateurs, groupes, Intune et Defender en langage naturel.

**À qui ce guide s'adresse :** admins du tenant LCI avec un compte `adm.aad.*@lcieducation.onmicrosoft.com`. Si ton compte admin n'est pas dans la liste d'autorisation (oids `--authorized-users` configurés par Marc), demande-lui avant de commencer.

**Deux chemins d'authentification — tu choisis :**

- **Flux navigateur (par défaut, le plus simple)** — Claude Desktop ouvre un onglet OAuth dans ton navigateur par défaut, tu te connectes, c'est fait. Fonctionne pour les comptes admin qui ne sont pas enrôlés dans Platform SSO (le cas commun chez LCI puisque les comptes `adm.aad.*` n'ont pas de licence Intune).
- **Flux device code (fallback)** — Si le flux navigateur échoue (Safari intercepté par une extension Microsoft Enterprise SSO, ou Mac headless), tu t'authentifies sur ton téléphone ou un autre appareil.

---

## Prérequis

| Élément                              | Comment vérifier                                       | Si absent                                                  |
| ------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------- |
| Claude Desktop                       | `open -a Claude` dans Terminal fonctionne              | Installer depuis https://claude.ai/download                |
| Node.js 18+                          | `node --version` dans Terminal                         | `brew install node` (Homebrew) ou https://nodejs.org (LTS) |
| Microsoft Authenticator (ou Yubikey) | Ton compte admin a déjà MFA activée                    | Voir avec IT si MFA pas encore configurée                  |
| Identifiants admin                   | `adm.aad.<ton-nom>@lcieducation.onmicrosoft.com` + MFA | —                                                          |

---

## Étape 1 — Configurer Claude Desktop

Ouvre Terminal et lance :

```bash
mkdir -p ~/Library/Application\ Support/Claude
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Si le fichier n'existe pas, TextEdit en crée un vide. Colle ce contenu (remplace tout ce qui s'y trouve déjà) :

```json
{
  "mcpServers": {
    "ms-365-admin": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp"
      ]
    }
  }
}
```

Sauvegarde (⌘S) et ferme TextEdit.

---

## Étape 2 — Lancer Claude Desktop (flux navigateur)

1. **Quitte Claude Desktop** s'il tourne déjà (⌘Q).
2. **Relance** depuis Spotlight (⌘Espace, tape "Claude") ou le Dock.
3. Un onglet navigateur s'ouvre automatiquement sur `login.microsoftonline.com/...` — ton navigateur par défaut s'en charge.
4. Connecte-toi avec ton compte admin : **adm.aad.\<ton-nom\>@lcieducation.onmicrosoft.com**
5. Complète MFA (notification Authenticator app ou Yubikey).
6. La page redirige vers `localhost:14543/oauth/callback` et affiche "Authentication successful — you can close this tab."

De retour dans Claude Desktop, le MCP `ms-365-admin` est maintenant connecté.

**Si tu vois "Server disconnected" ou l'onglet boucle sur une page broker Microsoft** — Platform SSO intercepte probablement via l'extension navigateur _Microsoft Enterprise SSO_. Passe au fallback device code ci-dessous.

---

## Étape 3 — Tester

Dans une nouvelle conversation :

> Liste-moi les 5 dernières alertes de sécurité Defender.

Claude devrait répondre en utilisant l'outil `list-security-alerts` du MCP `ms-365-admin`.

---

## Alternative : flux device code (fallback)

À utiliser si l'Étape 2 échoue avec "Server disconnected" ou si l'onglet navigateur boucle indéfiniment via un broker.

```bash
# 1. Quitte Claude Desktop (⌘Q)

# 2. Purge le cache OAuth
rm -rf ~/.mcp-auth/mcp-remote-*

# 3. Lance le bootstrap device code
cd ~
npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth \
  --server https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp
```

Tu verras :

```
────────────────────────────────────────────────────────────
 Microsoft 365 Admin MCP — device code authentication
────────────────────────────────────────────────────────────
 1. Open https://microsoft.com/devicelogin
 2. Enter code: XXXX-XXXX   (copied to clipboard)
 Waiting for authentication… (timeout 15 min)
────────────────────────────────────────────────────────────
```

Le code utilisateur est automatiquement copié dans ton presse-papier.

Sur ton téléphone (ou tout appareil avec un navigateur fonctionnel), va sur **https://microsoft.com/devicelogin**, colle le code, connecte-toi avec ton compte admin, complète MFA. Terminal affiche "Authentication complete" et écrit les tokens.

Relance Claude Desktop — `mcp-remote` récupère les tokens en cache, aucun onglet navigateur ne s'ouvre.

---

## Réinitialiser / ré-authentifier (premier réflexe en cas de problème)

Si Claude Desktop affiche "Server disconnected", si les appels d'outils échouent avec des erreurs d'authentification, ou si tu as changé de compte et veux te ré-authentifier :

```bash
# 1. Quitte Claude Desktop (⌘Q)

# 2. Supprime le cache d'authentification
rm -rf ~/.mcp-auth/mcp-remote-*

# 3. (Seulement si npx lui-même pose problème — ex. erreurs "command not found")
rm -rf ~/.npm/_npx

# 4. Relance Claude Desktop — le flux navigateur se déclenche à neuf.
#    (Si le navigateur échoue toujours, passe aux étapes device code ci-dessus.)
```

C'est sans danger — aucune donnée n'est perdue. Le cache ne contient que des tokens OAuth ; l'effacer force simplement une ré-authentification au prochain démarrage.

Situations courantes nécessitant une réinitialisation :

- Données anciennes ou erreurs après une mise à jour du serveur
- Tu as changé ton mot de passe admin ou re-enregistré MFA
- Ton refresh token a expiré (Entra les fait tourner périodiquement)
- Claude Desktop a été fermé en plein milieu d'un flux d'authentification

---

## Dépannage

**`ms-365-admin-mcp-auth: command not found` (lors du bootstrap device code)**
Tu es dans un dossier qui a son propre `node_modules`. Fais `cd ~` d'abord et réessaie.

**L'onglet navigateur s'ouvre mais redirige silencieusement via une page broker Microsoft**
L'extension _Microsoft Enterprise SSO_ est installée dans Safari/Chrome/Firefox. Options : désactive-la temporairement (`Safari > Réglages > Extensions`), utilise une fenêtre privée/incognito (les extensions sont désactivées par défaut en mode privé), passe à Brave/Arc pour ce flow, ou utilise le fallback device code.

**Claude Desktop affiche "Server disconnected" après redémarrage**
Vérifie que les tokens ont bien été écrits :

```bash
ls -la ~/.mcp-auth/mcp-remote-*/
```

S'il n'y a pas de fichier `*_tokens.json`, l'auth n'a pas abouti. Fais le reset puis réessaie (device code si le navigateur continue d'échouer).

**`AADSTS50105: Your account is not assigned to a role for the application`**
Ton oid admin n'est pas dans la liste `--authorized-users` du serveur. Contacte Marc.

**Autre problème**
Récupère :

- Le log récent de Claude Desktop : `~/Library/Logs/Claude/mcp-server-ms-365-admin.log`
- Le contenu de `~/.mcp-auth/mcp-remote-*/` (masque les valeurs des tokens)
- Le texte exact de l'erreur ou une capture d'écran

Envoie à Marc.

---

## Ce que le MCP peut faire

Couvre :

- **Sécurité** : alertes et incidents Defender, utilisateurs à risque Identity Protection, Secure Score, simulations d'attaque, threat intelligence.
- **Audit** : journaux d'audit du répertoire, connexions, journaux de provisionnement, éléments supprimés.
- **Identité** : utilisateurs, groupes, rôles du répertoire, assignations PIM éligibles/actives, stratégies d'accès conditionnel.
- **Intune** : appareils gérés, stratégies de conformité, configurations d'appareils, protection des applications.
- **Organisation** : SKUs souscrits (licences), intégrité des services, rapports d'utilisation.
- **Actions d'écriture** (actuellement activées sur le pilote) : `update-security-alert`, `dismiss-risky-user`, `revoke-user-sessions`, etc. Claude utilise tes permissions via OBO, donc aucune escalade au-delà de ce que ton compte peut déjà faire. Les rôles sensibles restent gated par PIM.

Liste complète des outils : `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-server --list-tools` — mais en pratique tu vas juste poser des questions en langage naturel à Claude.

## Notes de sécurité

- Les tokens sont en cache dans `~/.mcp-auth/` avec les permissions `0600` (lisibles uniquement par toi).
- Tes actions admin sont auditées dans Entra + Purview sous ton UPN comme si tu les avais faites toi-même (flux OBO délégué).
- Les rôles à haut risque (Global Admin, User Access Admin, Privileged Role Admin) restent protégés par PIM — la disponibilité d'un outil dans Claude ne contourne pas les exigences d'activation de rôle.
- Si tu quittes LCI ou changes de rôle, Marc révoque ton oid de `--authorized-users` côté serveur.
