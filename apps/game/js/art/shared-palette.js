// The colours the 2D minimal art (this folder) and the 3D minimal pack (tools/gen_minimal3d) share, so both looks
// read as one game: the same materials, terrain, team strip and shadow. tools/gen_minimal3d/core.py reads this file
// as JSON (the object literal below must stay strict JSON: double quotes, no comments, no trailing commas); the
// test apps/game/tests/minimal3d-size.test.mjs checks that it does.
//
// materials: named colours of the models and sprites (lit faces are drawn brighter and shaded faces darker from
//   these in 3D; 2D draws them flat).
// team: the preview team colour of the design boards (the game tints the team mask with the owner's colour).
// shadow: one hard shadow per object, offset to the bottom right by `offset` cells, black at `alpha`.
// terrain: per biome the flat tile colours: ground with an alternate tone, water one step lower (a darker edge
//   under the land), roads, ore and gems as two blocks per cell, trees as two blocks (crown and trunk).

export const SHARED_PALETTE = {
  "team": "#4d8cf2",
  "shadow": { "offset": 0.08, "alpha": 0.25 },
  "materials": {
    "concrete": "#bdb7a6", "wall": "#ddd6c4", "roof": "#ece6d6", "seam": "#c9c2ae", "steel": "#7d8a96",
    "steel2": "#aab7c3", "dark": "#4a5560", "darker": "#2e3238", "yellow": "#ffc93c", "glass": "#6ec6e6",
    "orange": "#f2b632", "gold": "#ffd34d", "glow": "#fff0a0", "molten": "#ff9a2a", "copper": "#d07a3a",
    "brick": "#c0573e", "wood": "#b0793f", "paint": "#f4f1e8", "steam": "#f2f6f8", "grass": "#6abe4a",
    "water": "#3aa0d8", "tiles": "#a8402e", "asphalt": "#5a5d63", "canvas": "#a3a55f", "sand": "#d6c48a",
    "red": "#e84a3a", "green": "#5ef08a", "blue": "#6ab0ff", "ice": "#7fe0ff", "ice2": "#e0f8ff",
    "dome": "#e4ebf0", "radar": "#4fd067", "dirt": "#9a8458", "camo": "#4f8a3a", "camo2": "#7ab84e",
    "field": "#ff5a3a", "shroud": "#1a2a3a", "rust": "#9a5a3a", "olive": "#6b7a3c", "sandy": "#c9ad6a",
    "black": "#141414", "skin": "#e8b98c", "char": "#3b3835", "char2": "#2a2724", "ash": "#575350"
  },
  "terrain": {
    "temperate": {
      "clear": "#6abe4a", "clearAlt": "#64b545", "rough": "#8fae4e", "roughStone": "#b3a67a",
      "rock": "#8a8f96", "rockLight": "#a9aeb5", "rockDark": "#6c7178",
      "water": "#3aa0d8", "waterLight": "#6cc4ee", "waterEdge": "#2a8cc4",
      "road": "#5a5d63", "ford": "#7fc6d8", "fordBank": "#d6c98f",
      "tree": "#7ab84e", "treeDark": "#4c9a3a", "trunk": "#b0793f",
      "ore": "#ffd34d", "oreDark": "#d9962a", "gems": ["#4a8cf0", "#e84ab0", "#3ad0b0"]
    },
    "snow": {
      "clear": "#e6eef4", "clearAlt": "#dbe6ee", "rough": "#cfdbe4", "roughStone": "#8d99a4",
      "rock": "#7f8a98", "rockLight": "#a3aebb", "rockDark": "#5f6a78",
      "water": "#5aa6d0", "waterLight": "#d8f2fc", "waterEdge": "#3d8ab8",
      "road": "#6a6f78", "ford": "#a9d4e6", "fordBank": "#c8d4dc",
      "tree": "#3f8566", "treeDark": "#2f6a52", "trunk": "#8a6a48",
      "ore": "#ffd34d", "oreDark": "#d9962a", "gems": ["#4a8cf0", "#e84ab0", "#3ad0b0"]
    },
    "desert": {
      "clear": "#dcc48a", "clearAlt": "#d4ba7e", "rough": "#c9a468", "roughStone": "#8f6f48",
      "rock": "#a07a52", "rockLight": "#c29a6c", "rockDark": "#7e5c3c",
      "water": "#28b8b0", "waterLight": "#6fe0d0", "waterEdge": "#1a9a98",
      "road": "#8a7a62", "ford": "#7fd0c8", "fordBank": "#e2cd96",
      "tree": "#8cb84e", "treeDark": "#6f9a3c", "trunk": "#a07a52",
      "ore": "#ffd34d", "oreDark": "#d9962a", "gems": ["#4a8cf0", "#e84ab0", "#3ad0b0"]
    }
  }
};
