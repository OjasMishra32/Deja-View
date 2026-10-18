-- Chess opponent test. Run from roblox/:  lune run tests/chess_bot_test.luau
-- Exercises the real ChessRules and ChessBot: takes free material, mates in one, stops a mate in one, and plays a
-- whole game against itself with only legal moves.
local R = require("../src/shared/ChessRules")
local Bot = require("../src/shared/ChessBot")

local failures = 0
local function check(name: string, ok: boolean, detail: string?)
	if ok then
		print(`PASS  {name}`)
	else
		failures += 1
		print(`FAIL  {name}  {detail or ""}`)
	end
end

-- A position from {square name = piece}, `turn` to play, no castling.
local function position(pieces: { [string]: string }, turn: string): any
	local board = {}
	for name, p in pieces do
		local f = string.byte(name, 1) - string.byte("a")
		local r = tonumber(string.sub(name, 2, 2)) :: number - 1
		board[r * 8 + f] = p
	end
	return { board = board, turn = turn, castle = { wK = false, wQ = false, bK = false, bQ = false }, ep = nil }
end

local function moveName(m: any): string
	return if m then R.name(m.from) .. R.name(m.to) else "none"
end

local fixed = function()
	return 0.5
end

-- 1. a hanging queen is taken
do
	local st = position({ e1 = "wK", d1 = "wR", d5 = "bQ", e8 = "bK", a7 = "bP" }, "w")
	local m = Bot.choose(R, st, fixed)
	check("takes the hanging queen", moveName(m) == "d1d5", moveName(m))
end

-- 2. a back-rank mate in one is played
do
	local st = position({ g1 = "wK", a1 = "wR", g8 = "bK", f7 = "bP", g7 = "bP", h7 = "bP" }, "w")
	local m = Bot.choose(R, st, fixed)
	local after = m and R.apply(st, m)
	check("mates in one", after ~= nil and R.status(after) == "checkmate", moveName(m))
end

-- 3. the same mate is stopped when it is the other side's move
do
	local st = position({ g1 = "wK", a1 = "wR", g8 = "bK", f7 = "bP", g7 = "bP", h7 = "bP", c6 = "bN" }, "b")
	local m = Bot.choose(R, st, fixed)
	local after = m and R.apply(st, m)
	local mated = false
	if after then
		for _, reply in Bot.allMoves(R, after) do
			if R.status(R.apply(after, reply)) == "checkmate" then
				mated = true
			end
		end
	end
	check("stops a mate in one", m ~= nil and not mated, moveName(m))
end

-- 4. a whole game against itself: every move legal, ends in mate, stalemate or the ply limit
do
	local seed = 7
	local function rng(): number
		seed = (seed * 1103515245 + 12345) % 2147483648
		return seed / 2147483648
	end
	local st = R.new()
	local plies, status, illegal, slowest = 0, "playing", 0, 0
	local t0 = os.clock()
	while plies < 160 do
		local t = os.clock()
		local m = Bot.choose(R, st, rng)
		slowest = math.max(slowest, os.clock() - t)
		if not m then
			break
		end
		local legal = false
		for _, lm in R.legalFrom(st, m.from) do
			if lm.to == m.to then
				legal = true
			end
		end
		if not legal then
			illegal += 1
		end
		st = R.apply(st, m)
		plies += 1
		status = R.status(st)
		if status == "checkmate" or status == "stalemate" then
			break
		end
	end
	print(`  self-play: {plies} plies, {status}, slowest move {math.floor(slowest * 1000)} ms, total {math.floor((os.clock() - t0) * 1000)} ms`)
	check("self-play moves are all legal", illegal == 0, `{illegal} illegal`)
	check("self-play runs", plies > 20, `{plies} plies`)
	check("a move takes under 0.25 s", slowest < 0.25, `{slowest}`)
end

if failures > 0 then
	error(`{failures} chess bot check(s) failed`)
end
print("all chess bot checks passed")
