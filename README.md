# Kitchen Table Skip-Bo League

A phone-friendly Skip-Bo scorekeeper, plus a Python builder that turns finished games into results pages. Sister site to the Phase 10 League.

## Scoring

Only the hand winner scores: **25 points plus 5 for each card left in the other players' stock piles**. First to 500 wins (250 and 1,000 are options). Stock piles are 30 cards for 2–4 players and 20 for 5 or more.

## How a game night works

1. Open the site, add players, and pick the target score.
2. Each hand, tap who emptied their stock pile, then enter how many cards everyone else has left. The page shows the points before you save.
3. Standings, the hand-by-hand grid and the race chart update after every hand. The game is saved in the browser, so a refresh loses nothing.
4. When someone reaches the target, tap **Download CSV**, then build the results page:

```bash
pip install -r builder/requirements.txt
python builder/build_site.py ~/Downloads/saturday-night.csv --game-label "Saturday night" --date 2026-11-21
# add a link to results/saturday-night.html under "Past games" in index.html
git add . && git commit -m "Add Saturday night results" && git push
```

The build also saves the game to the archive, `data/games.db`.

## Game archive (SQLite)

Every game you build is stored in `data/games.db`, so the full history lives in the repo, not just on one phone. Rebuilding the same CSV replaces that game instead of duplicating it. The file is created by the first build.

```bash
python builder/db.py games      # every game, newest first, with target and winner
python builder/db.py stats      # all-time wins, hands won, points per game
python builder/db.py sql "SELECT * FROM game_results WHERE player = 'Justin'"
python builder/db.py import old-game.csv --label "Summer 2026" --date 2026-07-04   # add a game without building a page
```

| Table / view | One row per |
|---|---|
| `players` | person (names match regardless of case) |
| `games` | game: `game_key` (the CSV name), `label`, `played_on`, `target`, `stock` |
| `hands` | player per hand: `won_hand` (0/1), `cards_left`, `points` |
| `game_results` (view) | player per game: `hands_won`, `points`, `place` |

You can also open `data/games.db` in [DB Browser for SQLite](https://sqlitebrowser.org/) or the VS Code SQLite extension.

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The scorekeeper (plain HTML/JS, no build step) |
| `builder/build_site.py` | Reads a game CSV, renders a results page and saves the game to the archive |
| `builder/db.py` | The SQLite archive: schema, import, `games`, `stats` and `sql` commands |
| `data/games.db` | The archive itself (created by the first build) |
| `builder/templates/results.html` | Jinja2 template; shares `style.css` with the app |
| `results/` | Built results pages |

CSV format: an optional `# target=500 stock=30` line, then `Hand, Player, Won hand?, Cards left`.

Not affiliated with Mattel, which owns the Skip-Bo name.
