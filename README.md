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
python builder/build_site.py ~/Downloads/saturday-night.csv --game-label "Saturday night"
# add a link to results/saturday-night.html under "Past games" in index.html
git add . && git commit -m "Add Saturday night results" && git push
```

## Files

| Path | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The scorekeeper (plain HTML/JS, no build step) |
| `builder/build_site.py` | Reads a game CSV and renders a results page |
| `builder/templates/results.html` | Jinja2 template; shares `style.css` with the app |
| `results/` | Built results pages |

CSV format: an optional `# target=500 stock=30` line, then `Hand, Player, Won hand?, Cards left`.

Not affiliated with Mattel, which owns the Skip-Bo name.
