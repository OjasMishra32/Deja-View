-- A small chess opponent for someone playing alone: looks one move ahead and at the best reply to it, counting
-- material (and mate), with a little weight on the centre, development and castling so it plays like a person.
-- Pure Luau: the caller passes ChessRules in, so it runs in Lune tests as well as on the server.
local ChessBot = {}

local VALUE = { P = 100, N = 300, B = 320, R = 500, Q = 900, K = 0 }
local MATE = 100000

-- Material and position for colour `c` minus the other side's.
local function score(board: { [number]: string? }, c: string): number
	local total = 0
	for sq, p in board do
		local kind = string.sub(p, 2, 2)
		local f, r = sq % 8, sq // 8
		local v = VALUE[kind]
		-- the centre is worth a little to pawns, knights and bishops
		if kind == "N" or kind == "B" or kind == "P" then
			v += 12 - 4 * (math.abs(3.5 - f) + math.abs(3.5 - r))
		end
		-- pawns are worth more the further they go (rank counted from their own side)
		if kind == "P" then
			v += 4 * (if string.sub(p, 1, 1) == "w" then r - 1 else 6 - r)
		end
		total += if string.sub(p, 1, 1) == c then v else -v
	end
	return total
end

local function allMoves(R: any, state: any): { any }
	local out = {}
	for sq = 0, 63 do
		local p = state.board[sq]
		if p and string.sub(p, 1, 1) == state.turn then
			for _, m in R.legalFrom(state, sq) do
				table.insert(out, m)
			end
		end
	end
	return out
end
ChessBot.allMoves = allMoves

-- The move for the side to play in `state` (ChessRules `R`), or nil when it has none. `rng` (0..1) breaks ties.
function ChessBot.choose(R: any, state: any, rng: (() -> number)?): any?
	local me = state.turn
	local random = rng or math.random
	local moves = allMoves(R, state)
	local best, bestScore = nil, -math.huge
	for _, m in moves do
		local after = R.apply(state, m)
		local replies = allMoves(R, after)
		local s: number
		if #replies == 0 then
			-- no reply: mate wins outright, stalemate is a draw (taken only when behind)
			s = if R.inCheck(after) then MATE else (if score(after.board, me) < -200 then 0 else -500)
		else
			-- the reply that hurts most (a mate in one is the worst)
			local worst = math.huge
			for _, rm in replies do
				local next = R.apply(after, rm)
				local v = score(next.board, me)
				if R.inCheck(next) and not R.hasMoves(next) then
					v = -MATE -- mated by this reply
				end
				if v < worst then
					worst = v
				end
				if worst <= -MATE then
					break
				end
			end
			s = worst
			-- develop knights and bishops off the back rank, castle, and give check now and then
			local p = state.board[m.from] :: string
			local kind = string.sub(p, 2, 2)
			local back = if me == "w" then 0 else 7
			if (kind == "N" or kind == "B") and m.from // 8 == back then
				s += 15
			end
			if m.castle then
				s += 40
			elseif kind == "K" then
				s -= 25
			end
			if R.inCheck(after) then
				s += 8
			end
		end
		s += random() * 6
		if s > bestScore then
			best, bestScore = m, s
		end
	end
	return best
end

return ChessBot
