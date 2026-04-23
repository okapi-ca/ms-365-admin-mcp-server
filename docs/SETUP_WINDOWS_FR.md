# MS 365 Admin MCP — Guide d'installation Windows (flux device code)

Connecte Claude Desktop sur ton laptop admin Windows au serveur MCP `ms-365-admin` LCI pour interroger les données M365 sécurité, audit, utilisateurs, groupes, Intune et Defender en langage naturel.

**À qui ce guide s'adresse :** admins du tenant LCI avec un compte `adm.aad.*@lcieducation.onmicrosoft.com`. Si ton compte admin n'est pas dans la liste d'autorisation (oids `--authorized-users` configurés par Marc), demande-lui avant de commencer.

**Pourquoi device code :** sur Windows, Edge / Chrome / Firefox se font tous intercepter par le broker WAM (Web Account Manager) de Microsoft. Le flux OAuth standard via navigateur n'aboutit pas. Le device code contourne complètement le navigateur — tu t'authentifies sur ton téléphone ou un autre appareil.

---

## Prérequis

| Élément                              | Comment vérifier                                       | Si absent                                                                           |
| ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Claude Desktop                       | `Démarrer > Claude` l'ouvre                            | Installer depuis https://claude.ai/download                                         |
| Node.js 18+                          | `node --version` dans PowerShell                       | Installer depuis https://nodejs.org (LTS) ou via `winget install OpenJS.NodeJS.LTS` |
| Microsoft Authenticator (ou Yubikey) | Ton compte admin a déjà MFA activée                    | Voir avec IT si MFA pas encore configurée                                           |
| Identifiants admin                   | `adm.aad.<ton-nom>@lcieducation.onmicrosoft.com` + MFA | —                                                                                   |

---

## Étape 1 — Configurer Claude Desktop

Ouvre PowerShell et lance :

```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

Si le fichier n'existe pas, Notepad propose de le créer — accepte. Colle ce contenu (remplace tout ce qui s'y trouve déjà) :

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

Sauvegarde (Ctrl+S) et ferme Notepad.

---

## Étape 2 — Lancer le bootstrap device code

Dans PowerShell :

```powershell
# Sortir de tout dossier projet Node pour éviter les conflits avec un node_modules local
cd $env:USERPROFILE

npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth `
  --server https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp
```

(Le backtick `` ` `` est le caractère de continuation de ligne PowerShell. Si tu préfères une seule ligne, supprime le `` ` `` et mets tout sur une ligne.)

Tu verras une sortie du style :

```
Discovering OAuth metadata at https://ca-cc-mcpms365admin-p…
Registering a fresh DCR client…
Requesting a device code…

────────────────────────────────────────────────────────────
 Microsoft 365 Admin MCP — device code authentication
────────────────────────────────────────────────────────────
 1. Open https://microsoft.com/devicelogin
 2. Enter code: XXXX-XXXX   (copied to clipboard)
 Waiting for authentication… (timeout 15 min)
────────────────────────────────────────────────────────────
```

Le code utilisateur est **automatiquement copié dans ton presse-papier**.

---

## Étape 3 — T'authentifier sur ton téléphone

1. Sur ton téléphone (ou tout appareil avec un navigateur fonctionnel), va sur **https://microsoft.com/devicelogin**
2. Saisis le code affiché dans PowerShell (il est déjà dans ton presse-papier — colle avec Ctrl+V sur laptop, ou l'action coller sur mobile).
3. Connecte-toi avec ton compte admin : **adm.aad.\<ton-nom\>@lcieducation.onmicrosoft.com**
4. Complète MFA (notification Authenticator app ou Yubikey).
5. Confirme l'écran de consentement si affiché.

De retour dans PowerShell, tu verras :

```
Authentication complete.
  cache dir:   C:\Users\<toi>\.mcp-auth\mcp-remote-0.1.38
  client info: …_client_info.json
  tokens:      …_tokens.json

Restart Claude Desktop / Claude Code — mcp-remote will reuse these tokens.
```

---

## Étape 4 — Redémarrer Claude Desktop et tester

1. Quitte Claude Desktop complètement (clic droit sur l'icône de la zone de notifications → Quitter, ou via le gestionnaire de tâches).
2. Relance Claude Desktop depuis le menu Démarrer.
3. Dans une nouvelle conversation, essaie ce prompt test :

   > Liste-moi les 5 dernières alertes de sécurité Defender.

   Claude devrait répondre en utilisant l'outil `list-security-alerts` du MCP `ms-365-admin`.

---

## Réinitialiser / ré-authentifier (premier réflexe en cas de problème)

Si Claude Desktop affiche "Server disconnected", si les appels d'outils échouent avec des erreurs d'authentification, ou si tu as changé de compte et veux te ré-authentifier, efface le cache de tokens et relance le bootstrap :

```powershell
# 1. Quitte Claude Desktop complètement (icône systray → Quitter, ou gestionnaire de tâches)

# 2. Supprime le cache d'authentification
Remove-Item -Recurse -Force "$env:USERPROFILE\.mcp-auth\mcp-remote-*"

# 3. (Seulement si npx lui-même pose problème — ex. erreurs "command not found")
Remove-Item -Recurse -Force "$env:USERPROFILE\.npm\_npx"

# 4. Relance le bootstrap (Étape 2 ci-dessus)
cd $env:USERPROFILE
npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth `
  --server https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp

# 5. Relance Claude Desktop
```

C'est sans danger — aucune donnée n'est perdue. Le cache ne contient que des tokens OAuth ; l'effacer force simplement une ré-authentification au prochain démarrage.

Situations courantes nécessitant une réinitialisation :

- Données anciennes ou erreurs après une mise à jour du serveur
- Tu as changé ton mot de passe admin ou re-enregistré MFA
- Ton refresh token a expiré (Entra les fait tourner périodiquement)
- Claude Desktop a été fermé en plein milieu d'un flux d'authentification

---

## Dépannage

**`ms-365-admin-mcp-auth: command not found`**
Tu es dans un dossier qui a son propre `node_modules`. Va d'abord dans ton dossier personnel (`cd $env:USERPROFILE`) et réessaie.

**Le bootstrap affiche `429 Too many token requests`**
C'était un bug en v0.6.0 — si tu vois ça, vérifie que tu utilises bien v0.6.1 ou plus récent : `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@0.6.1" …`

**Claude Desktop affiche "Server disconnected" après redémarrage**
Vérifie que les tokens ont bien été écrits :

```powershell
dir $env:USERPROFILE\.mcp-auth\mcp-remote-*\
```

S'il n'y a pas de fichier `*_tokens.json`, le bootstrap n'a pas abouti. Relance-le.

**`AADSTS50105: Your account is not assigned to a role for the application`**
Ton oid admin n'est pas dans la liste `--authorized-users` du serveur. Contacte Marc pour l'ajouter.

**Autre problème**
Récupère :

- La sortie de `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth --help`
- Le contenu de `%USERPROFILE%\.mcp-auth\mcp-remote-*\` (masque les valeurs des tokens)
- Le log récent de Claude Desktop : `%APPDATA%\Claude\Logs\mcp-server-ms-365-admin.log`

Et envoie à Marc.

---

## Ce que le MCP peut faire

Lecture seule par défaut. Couvre :

- **Sécurité** : alertes et incidents Defender, utilisateurs à risque Identity Protection, Secure Score, simulations d'attaque, threat intelligence.
- **Audit** : journaux d'audit du répertoire, connexions, journaux de provisionnement, éléments supprimés.
- **Identité** : utilisateurs, groupes, rôles du répertoire, assignations PIM éligibles/actives, stratégies d'accès conditionnel.
- **Intune** : appareils gérés, stratégies de conformité, configurations d'appareils, protection des applications.
- **Organisation** : SKUs souscrits (licences), intégrité des services, rapports d'utilisation.

Liste complète des outils : `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-server --list-tools` — mais en pratique tu vas juste poser des questions en langage naturel à Claude.

## Notes de sécurité

- Les tokens sont en cache dans `%USERPROFILE%\.mcp-auth\` et lisibles uniquement par ton utilisateur Windows.
- Le MCP tourne en mode lecture seule par défaut — aucune modification possible depuis Claude.
- Tes actions admin sont auditées dans Entra + Purview comme si tu les avais faites toi-même (flux OBO délégué).
- Si tu quittes LCI ou changes de rôle, Marc révoque ton oid de `--authorized-users` côté serveur.
