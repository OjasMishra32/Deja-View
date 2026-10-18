-- Picks MockServer or Api per call, so "use_mock" can flip live from Experience Configs.
local Config = require(script.Parent.Config)
local Api = require(script.Parent.Api)
local MockServer = require(script.Parent.MockServer)

local Backend = {}

local function impl()
	return if Config.useMock() then MockServer else Api
end

function Backend.scenes()
	return impl().scenes()
end

function Backend.map(sceneId: string, maxParts: number?)
	return impl().map(sceneId, maxParts)
end

function Backend.model(sceneId: string)
	return impl().model(sceneId)
end

function Backend.objects(sceneId: string)
	return impl().objects(sceneId)
end

function Backend.hotspots(sceneId: string)
	return impl().hotspots(sceneId)
end

function Backend.notes(sceneId: string)
	return impl().notes(sceneId)
end

function Backend.addNote(sceneId: string, body: any)
	return impl().addNote(sceneId, body)
end

function Backend.presence(sceneId: string, body: any)
	return impl().presence(sceneId, body)
end

function Backend.event(sceneId: string, body: any)
	return impl().event(sceneId, body)
end

-- Cross-play ping pong: real server only (the mock has no headsets).
function Backend.pingpong(sceneId: string, body: any)
	if Config.useMock() then
		return false, "mock", 0
	end
	return Api.pingpong(sceneId, body)
end

function Backend.pingpongWait(sceneId: string, after: number)
	if Config.useMock() then
		return false, "mock", 0
	end
	return Api.pingpongWait(sceneId, after)
end

function Backend.people(sceneId: string)
	return impl().people(sceneId)
end

-- Event delivery: one queue so the server sees events in order (a last tag before round end).
-- Each event retries up to 3 times with a 1 s gap, then is dropped (contract 5.4).
local queue: { { sceneId: string, body: any } } = {}
local draining = false

local function drain()
	draining = true
	while #queue > 0 do
		local item = table.remove(queue, 1)
		for attempt = 1, 4 do
			local ok, res, status = Backend.event(item.sceneId, item.body)
			if ok then
				break
			end
			warn("[DejaView] event failed (" .. tostring(status) .. "):", res, "attempt", attempt)
			if attempt < 4 then
				task.wait(1)
			end
		end
	end
	draining = false
end

function Backend.sendEvent(sceneId: string, body: any)
	table.insert(queue, { sceneId = sceneId, body = body })
	if not draining then
		task.spawn(drain)
	end
end

-- A finished match in the game.result contract (contracts.md 6.5): winner/loser as "rbx-<id>" or "bot",
-- the winner's score first, a round id made once at the match start.
function Backend.newRound(gameKey: string): string
	return gameKey .. "-" .. game:GetService("HttpService"):GenerateGUID(false)
end

function Backend.gameResult(r: { game: string, round: string, winner: Player?, loser: Player?, score: string,
	startedAt: number, draw: boolean?, winnerId: string?, winnerName: string?, loserId: string?, loserName: string? })
	local sceneId = workspace:GetAttribute("SceneId")
	if type(sceneId) ~= "string" or sceneId == "" then
		return
	end
	local function id(p: Player?): string
		return if p then "rbx-" .. p.UserId else "bot"
	end
	local function name(p: Player?): string
		return if p then string.sub(p.DisplayName, 1, 40) else "Bot"
	end
	local body: { [string]: any } = {
		type = "game.result", game = r.game, round = r.round,
		winner = r.winnerId or id(r.winner), winnerName = r.winnerName or name(r.winner),
		loser = r.loserId or id(r.loser), loserName = r.loserName or name(r.loser),
		score = if r.draw then "draw" else r.score, durationS = math.max(0, math.floor(os.clock() - r.startedAt)),
	}
	if r.draw then
		body.draw = true
	end
	Backend.sendEvent(sceneId, body)
end

return Backend
