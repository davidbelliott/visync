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
        return Vec2(self.x, self.y)


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


def pad_image_to_multiple(img, mult=16, color='black'):
    w, h = img.size
    pw = ((w + mult - 1) // mult) * mult
    ph = ((h + mult - 1) // mult) * mult
    if (pw, ph) == (w, h):
        return img
    out = Image.new(img.mode, (pw, ph), color=color)
    out.paste(img, (0, 0))
    return out


def render_walk_frame_png_style(allowed_moves, walk, grid_scale, line_width, margin, grid_dims,
                                bg_color='black', line_color='white', pad_mult=16):
    """
    Render ONE walk using the same coordinate/margin logic as walks_to_png,
    but without tiling (i=0).
    """
    # local coords in pixels
    coords = convert_walk_to_coords(allowed_moves, walk, grid_scale)

    # PNG style uses margin/2 offset, not full margin
    coords = [(margin / 2 + x, margin / 2 + y) for x, y in coords]

    img_w = grid_dims.x * grid_scale + margin
    img_h = grid_dims.y * grid_scale + margin

    img = Image.new('RGB', (img_w, img_h), color=bg_color)
    draw = ImageDraw.Draw(img)
    draw.line(coords, fill=line_color, width=line_width)

    return pad_image_to_multiple(img, mult=pad_mult, color=bg_color)


def walks_to_video(allowed_moves, found_walks, grid_scale, line_width, margin, grid_dims,
                   out_filename='out.mov', fps=12, hold_first=6, hold_last=12,
                   codec='qtrle', pad_mult=16,
                   persistence=0.3, drift_px=5, dwell_frames=1):
    """
    Flipbook: each walk is a frame (PNG-style render) with trailing persistence.

    persistence: 0..1
        0.0  -> no trails (only current frame)
        0.85 -> long-ish trails
        0.95 -> very long trails
    """
    import numpy as np
    import imageio.v2 as imageio

    if not found_walks:
        raise ValueError("No walks to render.")

    # Writer settings (unchanged)
    if codec == 'qtrle':
        writer_kwargs = dict(codec='qtrle', pixelformat='rgb24')
    elif codec == 'ffv1':
        writer_kwargs = dict(codec='ffv1', pixelformat='yuv444p')
    elif codec == 'prores_ks':
        writer_kwargs = dict(codec='prores_ks', pixelformat='yuv444p10le',
                             ffmpeg_params=['-profile:v', '4', '-vendor', 'apl0', '-vtag', 'ap4h'])
    else:
        writer_kwargs = dict(codec=codec)

    with imageio.get_writer(out_filename, fps=fps, **writer_kwargs) as w:

        accum = None  # float32 accumulator in 0..255

        # helper to emit a frame (with persistence)
        def emit_frame(frame_uint8):
            nonlocal accum
            cur = frame_uint8.astype(np.float32)

            if accum is None:
                accum = cur
            else:
                if drift_px > 0:
                    shifted = np.zeros_like(accum)
                    shifted[:-drift_px, :-drift_px] = accum[drift_px:, drift_px:]
                    accum = shifted
                # -----------------------------------------------------------

                # fade old content
                accum *= persistence
                # merge in new content at full strength
                accum = np.maximum(accum, cur)

            out = np.clip(accum, 0, 255).astype(np.uint8)
            w.append_data(out)

        # optional hold on first frame
        first_img = render_walk_frame_png_style(
            allowed_moves, found_walks[0],
            grid_scale=grid_scale,
            line_width=line_width,
            margin=margin,
            grid_dims=grid_dims,
            pad_mult=pad_mult
        )
        first_frame = np.array(first_img)
        for _ in range(max(0, hold_first)):
            emit_frame(first_frame)

        # main flipbook
        for walk in found_walks:
            frame_img = render_walk_frame_png_style(
                allowed_moves, walk,
                grid_scale=grid_scale,
                line_width=line_width,
                margin=margin,
                grid_dims=grid_dims,
                pad_mult=pad_mult
            )
            frame_np = np.array(frame_img)
            for _ in range(max(1, dwell_frames)):
                emit_frame(frame_np)

        # optional hold on last (with trails continuing to fade if you want)
        if hold_last > 0:
            last_img = render_walk_frame_png_style(
                allowed_moves, found_walks[-1],
                grid_scale=grid_scale,
                line_width=line_width,
                margin=margin,
                grid_dims=grid_dims,
                pad_mult=pad_mult
            )
            last_frame = np.array(last_img)
            for _ in range(hold_last):
                emit_frame(last_frame)



if __name__ == "__main__":
    grid_dims = Vec2(4, 3)
    allow_diagonals = True
    allow_diagonal_crossings = False

    moves = []
    if allow_diagonals:
        moves = [Vec2(*v) for v in [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]]
    else:
        moves = [Vec2(*v) for v in [[1, 0], [-1, 0], [0, 1], [0, -1]]]


    #found_walks = symmetric_random_walk(moves, [], [Vec2(0, 0)], grid_dims, allow_diagonal_crossings)

    allowed_table = [[[ m for m in moves if in_bounds(Vec2(x, y) + m, grid_dims) ] \
            for x in range(0, grid_dims.x + 1)] \
            for y in range(0, grid_dims.y + 1)]
    found_walks = random_walk_table(moves, allowed_table, [Vec2(0, 0)], [])

    print(len(found_walks))
    

    px_per_grid = 100
    margin_grids = 4
    walks_to_png(moves, found_walks, px_per_grid, 1, margin_grids * px_per_grid, grid_dims, 'out.png')

    walks_to_video(
        moves, found_walks,
        grid_scale=px_per_grid,
        line_width=1,
        margin=margin_grids * px_per_grid,
        grid_dims=grid_dims,
        out_filename='out.mov',
        fps=30,
        persistence=0.95,
        drift_px=2,
        dwell_frames=10,
        codec='prores_ks'
    )

    #walks_to_json(moves, found_walks, 1, 2, grid_dims, 'out.json')
