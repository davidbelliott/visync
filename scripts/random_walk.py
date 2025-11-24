import json
import copy
from PIL import Image, ImageDraw

class Vec2:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def __add__(self, other):
        return Vec2(self.x + other.x, self.y + other.y)

    def __sub__(self, other):
        return Vec2(self.x - other.x, self.y - other.y)

    def __neg__(self):
        return Vec2(-self.x, -self.y)

    def __mul__(self, scalar):
        return Vec2(self.x * scalar, self.y * scalar)

    def __repr__(self):
        return f'({self.x}, {self.y})'

    def __eq__(self, other):
        return self.x == other.x and self.y == other.y

    def clone(self):
        return Vec2(x, y)


def walk_eq(a, b):
    if len(a) != len(b):
        return False
    for i, m in enumerate(a):
        if m != b[i]:
            return False
    return True


def in_bounds(pos, grid_dims):
    return pos.x >= 0 and pos.y >= 0 and pos.x <= grid_dims.x and pos.y <= grid_dims.y


def random_walk_table(allowed_moves, allowed_moves_table, cursor_positions, moves_to_here, allow_diagonal_crossings=False):

    found_walks = []
    grid_dims = Vec2(len(allowed_moves_table[0]) - 1, len(allowed_moves_table) - 1)
    cur_pos = cursor_positions[-1]
    for move in allowed_moves_table[cur_pos.y][cur_pos.x]:
        start_coords = cur_pos
        start_coords_inv = grid_dims - start_coords
        end_coords = cur_pos + move
        end_coords_inv = grid_dims - end_coords

        if in_bounds(end_coords, grid_dims):

            if end_coords_inv == start_coords or end_coords_inv == end_coords:
                # New move closes the walk symmetrically
                found_walks.append(moves_to_here + [move])
            else:
                # Continue searching from here
                new_allowed_moves_table = copy.deepcopy(allowed_moves_table)
                for test_move in allowed_moves:
                    # Any move that lands on the start coords is now disallowed
                    for end in [start_coords, end_coords, start_coords_inv]:
                        start = end - test_move
                        if in_bounds(start, grid_dims):
                            try:
                                new_allowed_moves_table[start.y][start.x].remove(test_move)
                            except ValueError:
                                pass

                # If diagonal, disallow crossing diagonals
                if abs(move.x) > 0 and abs(move.y) > 0 and not allow_diagonal_crossings:
                    x0 = min(start_coords.x, end_coords.x)
                    x1 = max(start_coords.x, end_coords.x)
                    y0 = min(start_coords.y, end_coords.y)
                    y1 = max(start_coords.y, end_coords.y)

                    # Determine current diagonal orientation
                    dx = end_coords.x - start_coords.x
                    dy = end_coords.y - start_coords.y

                    # Corners of the cell:
                    # (x0,y0) ---- (x1,y0)
                    #    |           |
                    # (x0,y1) ---- (x1,y1)

                    if dx == dy:
                        # current is slope +1: (x0,y0)->(x1,y1)
                        cross_start = Vec2(x0, y1)
                        cross_end   = Vec2(x1, y0)
                    else:
                        # current is slope -1: (x0,y1)->(x1,y0)
                        cross_start = Vec2(x0, y0)
                        cross_end   = Vec2(x1, y1)

                    cross_move = cross_end - cross_start  # the crossing diagonal vector

                    def try_remove(start, mv):
                        if in_bounds(start, grid_dims):
                            try:
                                new_allowed_moves_table[start.y][start.x].remove(mv)
                            except ValueError:
                                pass

                    # Remove crossing diagonal in this cell (both directions)
                    try_remove(cross_start, cross_move)
                    try_remove(cross_end, cross_move * -1)

                    # Remove symmetric counterpart
                    inv_cross_start = grid_dims - cross_start
                    inv_cross_end   = grid_dims - cross_end
                    try_remove(inv_cross_start, cross_move * -1)
                    try_remove(inv_cross_end, cross_move)


                found_walks += random_walk_table(allowed_moves,
                        new_allowed_moves_table,
                        cursor_positions + [end_coords],
                        moves_to_here + [move],
                        allow_diagonal_crossings)

    return found_walks


def symmetric_random_walk(allowed_moves, moves_to_here, cursor_positions, grid_dims, allow_diagonal_crossings=False):
    found_walks = []

    for move in allowed_moves:
        new_pos = cursor_positions[-1] + move
        new_inv_pos = grid_dims - new_pos
        if in_bounds(new_pos, grid_dims) \
            and (new_pos not in cursor_positions) \
            and (new_inv_pos not in cursor_positions[:-1]):
           
            if new_inv_pos == cursor_positions[-1]:
                # New move closes the walk symmetrically
                found_walks.append(moves_to_here + [move])
            else:
                # Continue searching from here
                found_walks += symmetric_random_walk(allowed_moves, moves_to_here + [move], cursor_positions + [new_pos], grid_dims)

    return found_walks

def count_duplicates(walks):
    n_dup = 0
    for i, walk_a in enumerate(walks):
        for j, walk_b in enumerate(walks[:i]):
            if len(walk_a) != len(walk_b):
                continue

            is_dup = True
            for k, m in enumerate(walk_a):
                if walk_b[k] != m:
                    is_dup = False
                    break

            if is_dup:
                n_dup += 1

    return n_dup


def convert_walk_to_coords(allowed_moves, walk, pixel_scale):
   # Start at (0, 0) and build the list of global coordinates
   coords = [(0, 0)]
   current_pos = Vec2(0, 0)
   for move in walk:
       current_pos = current_pos + move * pixel_scale
       coords.append((current_pos.x, current_pos.y))
   for move in walk[-2::-1]:
       current_pos = current_pos + move * pixel_scale
       coords.append((current_pos.x, current_pos.y))
   return coords


def walks_to_png(allowed_moves, found_walks, grid_scale, line_width, margin, grid_dims, png_filename):
   walks_per_row = 16
   num_rows = 1 + (len(found_walks) - 1) // walks_per_row
   img_size = Vec2(walks_per_row * (grid_dims.x * grid_scale + margin),
                   num_rows * (grid_dims.y * grid_scale + margin))

   # Create a blank canvas
   img = Image.new('RGB', (img_size.x, img_size.y), color='black')
   draw = ImageDraw.Draw(img)

   # Iterate through each walk and plot
   for i, walk in enumerate(found_walks):
       # Get local coords
       coords = convert_walk_to_coords(allowed_moves, walk, grid_scale)
       # Convert to world coords
       coords = [(margin / 2 + x + (i % walks_per_row) * (grid_dims.x * grid_scale + margin),
                  margin / 2 + y + (i // walks_per_row) * (grid_dims.y * grid_scale + margin)) for x, y in coords]

       x_vals, y_vals = zip(*coords)
       draw.line(coords, fill='white', width=line_width)

   # Save as PNG
   img.save(png_filename)


def walks_to_json(allowed_moves, found_walks, grid_scale, margin, grid_dims, json_filename):
   walks_per_row = 16
   num_rows = 1 + (len(found_walks) - 1) // walks_per_row

   walks_data = []
   for i, walk in enumerate(found_walks):
       # Get local coords
       coords = convert_walk_to_coords(allowed_moves, walk, grid_scale)
       # Convert to world coords
       coords = [(x + (i % walks_per_row) * (grid_dims.x * grid_scale + margin),
                  y + (i // walks_per_row) * (grid_dims.y * grid_scale + margin)) for x, y in coords]
       walks_data.append(coords)

   with open(json_filename, 'w') as f:
       json.dump(walks_data, f)


if __name__ == "__main__":
    grid_dims = Vec2(4, 3)
    allow_diagonals = True
    allow_diagonal_crossings = False

    moves = []
    if allow_diagonals:
        for x in [-1, 0, 1]:
            for y in ([-1, 0, 1] if x != 0 else [-1, 1]):
                moves.append(Vec2(x, y))
    else:
        moves = [Vec2(*v) for v in [[1, 0], [-1, 0], [0, 1], [0, -1]]]


    #found_walks = symmetric_random_walk(moves, [], [Vec2(0, 0)], grid_dims, allow_diagonal_crossings)

    allowed_table = [[[ m for m in moves if in_bounds(Vec2(x, y) + m, grid_dims) ] \
            for x in range(0, grid_dims.x + 1)] \
            for y in range(0, grid_dims.y + 1)]
    found_walks = random_walk_table(moves, allowed_table, [Vec2(0, 0)], [])

    print(len(found_walks))
    

    px_per_grid = 10
    margin_grids = 4
    walks_to_png(moves, found_walks, px_per_grid, 1, margin_grids * px_per_grid, grid_dims, 'out.png')

    #walks_to_json(moves, found_walks, 1, 2, grid_dims, 'out.json')
