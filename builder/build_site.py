"""Build a Skip-Bo League results page from a game CSV.

Usage:
    python builder/build_site.py ~/Downloads/game-1.csv --game-label "Game 1"

Writes results/<csv name>.html. The CSV comes from the scorekeeper's
"Download CSV" button:

    # target=500 stock=30          <- optional settings line
    Hand,Player,Won hand?,Cards left
"""

from __future__ import annotations

import argparse
import csv
import math
from dataclasses import dataclass, field
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape
from markupsafe import Markup

HERE = Path(__file__).parent
WIN_BONUS = 25
PER_CARD = 5

# Colors are handed out by final rank, so the champion always gets blue.
PALETTE = ["var(--blue)", "var(--red)", "var(--green)", "var(--orange)", "var(--purple)", "var(--teal)"]
SCOREKEEPER_URL = "../index.html"  # results pages live in results/, the app at the repo root


# ---------------------------------------------------------------- data model

@dataclass
class Player:
    name: str
    won: list[bool] = field(default_factory=list)   # one entry per hand
    left: list[int] = field(default_factory=list)   # cards left in stock pile
    points: list[int] = field(default_factory=list)  # filled in by score_hands()
    color: str = ""

    @property
    def total(self) -> int:
        return sum(self.points)

    @property
    def wins(self) -> int:
        return sum(self.won)  # True counts as 1

    @property
    def best(self) -> int:
        return max(self.points, default=0)

    @property
    def cumulative(self) -> list[int]:
        running, out = 0, [0]  # start at 0 so the chart begins at "Start"
        for p in self.points:
            running += p
            out.append(running)
        return out

    def longest_win_streak(self) -> tuple[int, int]:
        """(length, start index) of the longest run of hands won."""
        best_len = best_start = cur = 0
        for i, w in enumerate(self.won):
            cur = cur + 1 if w else 0
            if cur > best_len:
                best_len, best_start = cur, i - cur + 1
        return best_len, best_start


@dataclass
class Game:
    players: list[Player]
    target: int = 500
    stock: int = 30

    @property
    def hands(self) -> int:
        return len(self.players[0].won)


# ------------------------------------------------------------------- loading

def parse_bool(text: str) -> bool:
    return text.strip().upper() in {"TRUE", "YES", "Y", "1", "X"}


def parse_settings(line: str) -> dict[str, int]:
    """'# target=500 stock=30' -> {'target': 500, 'stock': 30}"""
    pairs = (part.split("=", 1) for part in line.lstrip("#").split() if "=" in part)
    return {k: int(v) for k, v in pairs if v.isdigit()}


def load_game(csv_path: Path) -> Game:
    settings: dict[str, int] = {}
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        lines = f.read().splitlines()

    # Pull out "#" settings lines first. csv.DictReader would otherwise take the
    # first line as the header row and every column name would be wrong.
    data_lines = []
    for line in lines:
        if line.startswith("#"):
            settings.update(parse_settings(line))
        elif line.strip():
            data_lines.append(line)

    players: dict[str, Player] = {}
    for row in csv.DictReader(data_lines):
        name = (row.get("Player") or "").strip()
        if not name:
            continue
        player = players.setdefault(name.casefold(), Player(name=name))
        # Hand number = how many rows this player has so far, same as the Phase 10 builder.
        won = parse_bool(row.get("Won hand?", ""))
        player.won.append(won)
        player.left.append(0 if won else int(float(row.get("Cards left") or 0)))

    if len(players) < 2:
        raise SystemExit(f"Need at least two players in {csv_path}")
    game = Game(list(players.values()), **settings)
    if len({len(p.won) for p in game.players}) != 1:
        counts = ", ".join(f"{p.name}: {len(p.won)}" for p in game.players)
        raise SystemExit(f"Players have different numbers of hands ({counts}). Check the CSV.")
    score_hands(game)
    return game


def score_hands(game: Game) -> None:
    """Only the hand winner scores: 25 plus 5 per card left in the other stock piles."""
    for p in game.players:
        p.points = []
    for k in range(game.hands):
        winners = [p for p in game.players if p.won[k]]
        if len(winners) != 1:
            raise SystemExit(f"Hand {k + 1} has {len(winners)} winners. Each hand needs exactly one.")
        cards = sum(p.left[k] for p in game.players)  # the winner's own entry is 0
        for p in game.players:
            p.points.append(WIN_BONUS + PER_CARD * cards if p.won[k] else 0)


# ------------------------------------------------------------------- results

def rank(players: list[Player]) -> list[Player]:
    ranked = sorted(players, key=lambda p: (-p.total, -p.wins))
    for player, color in zip(ranked, PALETTE * 2):
        player.color = color
    return ranked


def headline(game: Game, ranked: list[Player]) -> dict:
    champ = ranked[0]
    finished = champ.total >= game.target
    title = "takes the crown" if finished else f"leads after hand {game.hands}"
    # Markup.format() escapes each argument, so names stay plain text inside real HTML.
    blurb = Markup("{c} {verb} <strong>{t:,} points</strong> in {h} hands, winning {w} of them.").format(
        c=champ.name, verb="reached" if finished else "has", t=champ.total, h=game.hands, w=champ.wins)
    return {"champ": champ, "title": title, "blurb": blurb, "finished": finished}


def names(group: list[Player]) -> str:
    n = [p.name for p in group]
    return n[0] if len(n) == 1 else ", ".join(n[:-1]) + " and " + n[-1]


def awards(game: Game, ranked: list[Player]) -> list[dict]:
    out = []

    top = max(ranked, key=lambda p: p.best)
    hand_no = top.points.index(top.best) + 1
    out.append({"big": f"{top.best:,}", "title": "Big score", "color": top.color,
                "text": f"{top.name}'s hand {hand_no} win was the biggest of the game."})

    most = max(p.wins for p in ranked)
    who = [p for p in ranked if p.wins == most]
    out.append({"big": most, "title": "Stock pile cleared", "color": who[0].color,
                "text": f"{names(who)} won {most} of {game.hands} hands, the most of anyone."})

    # Fewest cards left in a hand someone lost: closest to winning it.
    losses = [(p.left[k], p, k) for p in ranked for k in range(game.hands) if not p.won[k]]
    if losses:
        n, p, k = min(losses, key=lambda t: t[0])
        out.append({"big": n, "title": "So close", "color": p.color,
                    "text": f"{p.name} was {n} card{'s' if n != 1 else ''} away from winning hand {k + 1}."})

    streaks = {p.name: p.longest_win_streak() for p in ranked}
    hot = max(ranked, key=lambda p: streaks[p.name][0])
    length, start = streaks[hot.name]
    if length >= 2:
        out.append({"big": length, "title": "Hot streak", "color": hot.color,
                    "text": f"{hot.name} won {length} hands in a row, hands {start + 1} to {start + length}."})
    return out


def chart(game: Game, ranked: list[Player]) -> dict:
    """Pre-compute SVG coordinates so the template only draws."""
    W, H, L, R, T, B = 900, 360, 52, 110, 16, 40
    n = game.hands
    top = max(game.target, math.ceil(max(p.total for p in ranked) / 100) * 100)
    step = 100 if top <= 600 else 200 if top <= 1200 else 500

    def x(i: int) -> float:
        return L + (W - L - R) * (i / n)

    def y(v: float) -> float:
        return T + (H - T - B) * (1 - v / top)

    lines = []
    for p in ranked:
        pts = [(x(i), y(v)) for i, v in enumerate(p.cumulative)]
        path = " ".join(f"{'L' if i else 'M'}{px:.1f},{py:.1f}" for i, (px, py) in enumerate(pts))
        lines.append({"player": p, "path": path, "end": pts[-1]})

    labels = sorted(({"player": l["player"], "y": l["end"][1]} for l in lines), key=lambda d: d["y"])
    for prev, cur in zip(labels, labels[1:]):
        cur["y"] = max(cur["y"], prev["y"] + 16)

    return {
        "W": W, "H": H, "L": L, "R": R, "B": B,
        "grid": [{"v": v, "y": y(v)} for v in range(0, top + 1, step)],
        "xticks": [{"label": "Start" if i == 0 else i, "x": x(i)} for i in range(n + 1)],
        "target_y": y(game.target),
        "lines": lines,
        "labels": labels,
        "label_x": W - R + 10,
    }


# ------------------------------------------------------------------- render

def build(csv_path: Path, out_path: Path, league: str, game_label: str) -> Path:
    game = load_game(csv_path)
    ranked = rank(game.players)

    env = Environment(
        loader=FileSystemLoader(HERE / "templates"),
        autoescape=select_autoescape(["html"]),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    env.globals["zip"] = zip
    html = env.get_template("results.html").render(
        league=league,
        game_label=game_label,
        game=game,
        players=ranked,
        head=headline(game, ranked),
        awards=awards(game, ranked),
        chart=chart(game, ranked),
        scorekeeper_url=SCOREKEEPER_URL,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html, encoding="utf-8")
    return out_path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv", type=Path, help="Game CSV from the scorekeeper")
    ap.add_argument("--league", default="Kitchen Table", help="League name (default: %(default)s)")
    ap.add_argument("--game-label", default="Game 1", help='Shown in the header, e.g. "Saturday night"')
    ap.add_argument("-o", "--out", type=Path, default=None, help="Default: results/<csv name>.html")
    args = ap.parse_args()

    out_path = args.out or HERE.parent / "results" / f"{args.csv.stem}.html"
    print(f"Wrote {build(args.csv, out_path, args.league, args.game_label)}")


if __name__ == "__main__":
    main()
