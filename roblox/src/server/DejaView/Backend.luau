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

function Backend.presence(sceneId: string, body: any)
	return impl().presence(sceneId, body)
end

function Backend.event(sceneId: string, body: any)
	return impl().event(sceneId, body)
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

return Backend
