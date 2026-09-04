# Bati'Coût V1.2

PWA mobile de suivi de chantier, dépenses et temps de travail.

## Nouveautés V1.2

- **Modification complète des dépenses** : enseigne, date, montant, TVA, catégorie, lot par défaut, payeur et description.
- **Réédition des tickets** : affichage de la photo enregistrée, remplacement de la photo, correction/ajout/suppression des lignes et réaffectation de chaque ligne à un lot.
- **Budget prévisionnel par lot** avec suivi prévu / dépensé / restant et signalement des dépassements.
- **Taux de main-d’œuvre par lot** : le taux est proposé automatiquement lors d’une saisie d’heures et utilisé par le chronomètre.
- **Payé par** : une dépense peut être attribuée à n’importe quel membre du projet, indépendamment de la personne qui la saisit.
- **Bilan enrichi** : budget total, consommation, reste, valeur MO, comparaison par lot, répartition des dépenses par payeur.
- Conservation des fonctions V1.1 : tickets multi-lots, gestion sécurisée des lots, planning, OCR, plusieurs projets, équipe, export CSV et PWA.

## Tester en mode local

Sans configuration Supabase, ouvrir l’application via un petit serveur local puis choisir **Continuer en mode démo local**. Les données V1/V1.1 stockées dans le navigateur sont migrées automatiquement : les lots existants reçoivent un budget de 0 € et un taux horaire proposé à partir de l’historique quand c’est possible, sinon 45 €/h.

Exemple :

```bash
python -m http.server 8000
```

Puis ouvrir `http://localhost:8000`.

## Mise à jour depuis la V1.1 avec Supabase

1. Remplacer les fichiers web modifiés (`index.html`, `styles.css`, `app.js`, `sw.js`).
2. Dans **Supabase > SQL Editor**, exécuter **une seule fois** `migration_v1_2.sql`.
3. Republier le site.

La migration :
- ajoute `budget` et `hourly_rate` aux lots ;
- ajoute `paid_by_user_id` aux dépenses ;
- rattache les anciennes dépenses à leur auteur comme payeur initial ;
- autorise les admins/propriétaires à modifier les paramètres des lots ;
- conserve toutes les données V1.1.

## Installation neuve

Pour un nouveau projet Supabase, exécuter directement `setup.sql`, qui contient désormais les schémas V1 + V1.1 + V1.2. Ensuite renseigner `config.js` :

```js
window.BATICOUT_CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_ANON_KEY: "votre-cle-publique"
};
```

## Notes OCR

L’OCR Tesseract reste une aide à la saisie. Les lignes de ticket détectées doivent être vérifiées avant enregistrement. Après enregistrement, elles restent entièrement modifiables dans la V1.2.

## Palette

- Bleu nuit `#0D1B2A`
- Vert sauge `#8FA17A`
- Sable clair `#F3EFE7`
- Terre cuite `#D66A4A`
- Lavande `#C4B5FD`
