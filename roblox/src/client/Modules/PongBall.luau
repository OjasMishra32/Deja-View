-- Draws the ping pong ball locally from the server's shot description (same arcs the server uses), so it is smooth.
local PongBall = {}

local ball: Part? = nil
local shot: any = nil
local resting: Vector3? = nil

local function ensureBall(): Part
	if ball and ball.Parent then
		return ball
	end
	local p = Instance.new("Part")
	p.Name = "PongBall"
	p.Shape = Enum.PartType.Ball
	p.Size = Vector3.new(0.7, 0.7, 0.7)
	p.Color = Color3.fromRGB(255, 160, 40)
	p.Material = Enum.Material.Neon
	p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch = true, false, false, false
	p.Parent = workspace
	ball = p
	return p
end

function PongBall.onMoment(m: any)
	if m.type == "pongShot" then
		shot, resting = m, nil
	elseif m.type == "pongWait" then
		shot, resting = nil, m.pos
	elseif m.type == "pongEnd" then
		shot, resting = nil, nil
		if ball then
			ball:Destroy()
			ball = nil
		end
	end
end

function PongBall.update()
	if resting then
		ensureBall().CFrame = CFrame.new(resting + Vector3.new(0, 0.3 * math.sin(os.clock() * 4), 0))
		return
	end
	if not shot then
		return
	end
	local dt = workspace:GetServerTimeNow() - shot.t0
	local pos
	if dt < 0 then
		pos = shot.p0
	elseif dt <= shot.t1 then
		local a = dt / shot.t1
		pos = shot.p0:Lerp(shot.b, a) + Vector3.new(0, 4 * shot.h1 * a * (1 - a), 0)
	else
		local a = math.min((dt - shot.t1) / shot.t2, 1.6)
		pos = shot.b:Lerp(shot.p2, a) + Vector3.new(0, 4 * shot.h2 * a * (1 - a), 0)
	end
	ensureBall().CFrame = CFrame.new(pos)
end

return PongBall
