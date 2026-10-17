-- Chess rules: legal moves (check, castling, en passant, promotion), checkmate and stalemate.
-- Squares are 0..63 with a1 = 0, h1 = 7, a8 = 56. Pieces are "wP", "bK", ... (colour + PNBRQK).
local ChessRules = {}

export type State = {
	board: { [number]: string? },
	turn: string, -- "w" | "b"
	castle: { [string]: boolean }, -- wK, wQ, bK, bQ
	ep: number?, -- en passant target square
}

export type Move = { from: number, to: number, promo: string?, castle: string?, ep: boolean? }

local function file(sq: number): number
	return sq % 8
end

local function rank(sq: number): number
	return sq // 8
end

local function at(f: number, r: number): number?
	if f < 0 or f > 7 or r < 0 or r > 7 then
		return nil
	end
	return r * 8 + f
end

local function other(c: string): string
	return if c == "w" then "b" else "w"
end
ChessRules.other = other

function ChessRules.new(): State
	local board = {}
	local back = { "R", "N", "B", "Q", "K", "B", "N", "R" }
	for f = 0, 7 do
		board[f] = "w" .. back[f + 1]
		board[8 + f] = "wP"
		board[48 + f] = "bP"
		board[56 + f] = "b" .. back[f + 1]
	end
	return { board = board, turn = "w", castle = { wK = true, wQ = true, bK = true, bQ = true }, ep = nil }
end

function ChessRules.name(sq: number): string
	return string.sub("abcdefgh", file(sq) + 1, file(sq) + 1) .. tostring(rank(sq) + 1)
end

local KNIGHT: { { number } } = { { 1, 2 }, { 2, 1 }, { 2, -1 }, { 1, -2 }, { -1, -2 }, { -2, -1 }, { -2, 1 }, { -1, 2 } }
local KING: { { number } } = { { 1, 0 }, { 1, 1 }, { 0, 1 }, { -1, 1 }, { -1, 0 }, { -1, -1 }, { 0, -1 }, { 1, -1 } }
local ROOK = { { 1, 0 }, { -1, 0 }, { 0, 1 }, { 0, -1 } }
local BISHOP = { { 1, 1 }, { 1, -1 }, { -1, 1 }, { -1, -1 } }

-- Is `sq` attacked by colour `by`?
function ChessRules.attacked(board: { [number]: string? }, sq: number, by: string): boolean
	local f, r = file(sq), rank(sq)
	local dir = if by == "w" then -1 else 1 -- pawns of `by` sit one rank behind the square they attack
	for _, df in { -1, 1 } do
		local s = at(f + df, r + dir)
		if s and board[s] == by .. "P" then
			return true
		end
	end
	for _, d in KNIGHT do
		local s = at(f + d[1], r + d[2])
		if s and board[s] == by .. "N" then
			return true
		end
	end
	for _, d in KING do
		local s = at(f + d[1], r + d[2])
		if s and board[s] == by .. "K" then
			return true
		end
	end
	for _, set in { { ROOK, "R" }, { BISHOP, "B" } } do
		for _, d in set[1] do
			local cf, cr = f + d[1], r + d[2]
			while true do
				local s = at(cf, cr)
				if not s then
					break
				end
				local p = board[s]
				if p then
					if p == by .. set[2] or p == by .. "Q" then
						return true
					end
					break
				end
				cf, cr = cf + d[1], cr + d[2]
			end
		end
	end
	return false
end

local function kingSquare(board: { [number]: string? }, c: string): number?
	for s = 0, 63 do
		if board[s] == c .. "K" then
			return s
		end
	end
	return nil
end

function ChessRules.inCheck(state: State, c: string?): boolean
	local colour = c or state.turn
	local k = kingSquare(state.board, colour)
	return k ~= nil and ChessRules.attacked(state.board, k, other(colour))
end

-- Moves that obey piece movement, ignoring whether our own king is left in check.
local function pseudo(state: State, from: number): { Move }
	local board, out = state.board, {}
	local p = board[from]
	if not p then
		return out
	end
	local c, kind = string.sub(p, 1, 1), string.sub(p, 2, 2)
	local f, r = file(from), rank(from)
	local function add(to: number, extra: { [string]: any }?)
		local m: Move = { from = from, to = to }
		if extra then
			for k, v in extra do
				(m :: any)[k] = v
			end
		end
		table.insert(out, m)
	end
	local function canLand(s: number): boolean
		local q = board[s]
		return q == nil or string.sub(q, 1, 1) ~= c
	end
	if kind == "P" then
		local dir = if c == "w" then 1 else -1
		local startRank, lastRank = if c == "w" then 1 else 6, if c == "w" then 7 else 0
		local one = at(f, r + dir)
		if one and not board[one] then
			add(one, if rank(one) == lastRank then { promo = "Q" } else nil)
			local two = at(f, r + 2 * dir)
			if r == startRank and two and not board[two] then
				add(two)
			end
		end
		for _, df in { -1, 1 } do
			local s = at(f + df, r + dir)
			if s then
				local q = board[s]
				if q and string.sub(q, 1, 1) ~= c then
					add(s, if rank(s) == lastRank then { promo = "Q" } else nil)
				elseif s == state.ep then
					add(s, { ep = true })
				end
			end
		end
	elseif kind == "N" or kind == "K" then
		local steps: { { number } } = if kind == "N" then KNIGHT else KING
		for _, d in steps do
			local s = at(f + d[1], r + d[2])
			if s and canLand(s) then
				add(s)
			end
		end
		if kind == "K" then
			local home = if c == "w" then 4 else 60
			local enemy = other(c)
			if from == home and not ChessRules.attacked(board, home, enemy) then
				if state.castle[c .. "K"] and not board[home + 1] and not board[home + 2] and board[home + 3] == c .. "R"
					and not ChessRules.attacked(board, home + 1, enemy) and not ChessRules.attacked(board, home + 2, enemy) then
					add(home + 2, { castle = "K" })
				end
				if state.castle[c .. "Q"] and not board[home - 1] and not board[home - 2] and not board[home - 3]
					and board[home - 4] == c .. "R"
					and not ChessRules.attacked(board, home - 1, enemy) and not ChessRules.attacked(board, home - 2, enemy) then
					add(home - 2, { castle = "Q" })
				end
			end
		end
	else
		local dirs = if kind == "R" then ROOK elseif kind == "B" then BISHOP else nil
		local lists = if dirs then { dirs } else { ROOK, BISHOP }
		for _, list in lists do
			for _, d in list do
				local cf, cr = f + d[1], r + d[2]
				while true do
					local s = at(cf, cr)
					if not s then
						break
					end
					local q = board[s]
					if q == nil then
						add(s)
					else
						if string.sub(q, 1, 1) ~= c then
							add(s)
						end
						break
					end
					cf, cr = cf + d[1], cr + d[2]
				end
			end
		end
	end
	return out
end

-- Returns a new state with the move applied (no legality check).
function ChessRules.apply(state: State, m: Move): State
	local board = table.clone(state.board)
	local p = board[m.from] :: string
	local c = string.sub(p, 1, 1)
	board[m.to] = if m.promo then c .. m.promo else p
	board[m.from] = nil
	if m.ep then
		board[m.to + (if c == "w" then -8 else 8)] = nil
	end
	if m.castle == "K" then
		board[m.from + 1], board[m.from + 3] = board[m.from + 3], nil
	elseif m.castle == "Q" then
		board[m.from - 1], board[m.from - 4] = board[m.from - 4], nil
	end
	local castle = table.clone(state.castle)
	local function touch(sq: number)
		if sq == 4 then
			castle.wK, castle.wQ = false, false
		elseif sq == 60 then
			castle.bK, castle.bQ = false, false
		elseif sq == 0 then
			castle.wQ = false
		elseif sq == 7 then
			castle.wK = false
		elseif sq == 56 then
			castle.bQ = false
		elseif sq == 63 then
			castle.bK = false
		end
	end
	touch(m.from)
	touch(m.to)
	local ep = nil
	if string.sub(p, 2, 2) == "P" and math.abs(m.to - m.from) == 16 then
		ep = (m.from + m.to) // 2
	end
	return { board = board, turn = other(state.turn), castle = castle, ep = ep }
end

-- Legal moves for the piece on `from` (it must belong to the side to move).
function ChessRules.legalFrom(state: State, from: number): { Move }
	local p = state.board[from]
	if not p or string.sub(p, 1, 1) ~= state.turn then
		return {}
	end
	local out = {}
	for _, m in pseudo(state, from) do
		local after = ChessRules.apply(state, m)
		if not ChessRules.inCheck(after, state.turn) then
			table.insert(out, m)
		end
	end
	return out
end

function ChessRules.hasMoves(state: State): boolean
	for s = 0, 63 do
		if #ChessRules.legalFrom(state, s) > 0 then
			return true
		end
	end
	return false
end

-- "playing" | "check" | "checkmate" | "stalemate"
function ChessRules.status(state: State): string
	local check = ChessRules.inCheck(state)
	if not ChessRules.hasMoves(state) then
		return if check then "checkmate" else "stalemate"
	end
	return if check then "check" else "playing"
end

return ChessRules
