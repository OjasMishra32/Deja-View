-- Draws the judge (head, hands, faint body), web viewers (orbs) and other-server Roblox players,
-- each DELAY seconds in the past, sliding between server snapshots.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("Shared")
local Theme = require(Shared.Theme)
local Interp = require(Shared.Interp)

local Ghosts = {}

type Ghost = {
	id: string,
	kind: string,
	buf: Interp.Buffer,
	model: Model,
	head: BasePart,
	hl: BasePart?,
	hr: BasePart?,
	body: BasePart?,
	label: TextLabel,
	sub: TextLabel,
	itChip: TextLabel?,
	fade: number, -- 1 visible -> 0 gone
	gone: boolean,
	base: { [BasePart]: number },
}

local ghosts: { [string]: Ghost } = {}
local folder = Instance.new("Folder")
folder.Name = "Ghosts"
folder.Parent = workspace

local function ball(model: Model, name: string, size: number, transparency: number): BasePart
	local p = Instance.new("Part")
	p.Name = name
	p.Shape = Enum.PartType.Ball
	p.Size = Vector3.new(size, size, size)
	p.Material = Enum.Material.Neon
	p.Color = Theme.Accent
	p.Transparency = transparency
	p.Anchored, p.CanCollide, p.CanQuery, p.CanTouch, p.CastShadow = true, false, false, false, false
	p.Parent = model
	return p
end

local function billboard(adornee: BasePart, text: string, offset: number)
	local gui = Theme.make("BillboardGui", {
		Size = UDim2.fromOffset(180, 54),
		StudsOffset = Vector3.new(0, offset, 0),
		AlwaysOnTop = true,
		LightInfluence = 0,
		MaxDistance = 200,
		Adornee = adornee,
		Parent = adornee,
	})
	local label = Theme.label({ Text = text, Size = UDim2.new(1, 0, 0.5, 0), TextXAlignment = Enum.TextXAlignment.Center,
		FontFace = Theme.Heading, TextStrokeTransparency = 0.4, MaxText = 20, Parent = gui })
	local sub = Theme.label({ Text = "", Size = UDim2.new(1, 0, 0.35, 0), Position = UDim2.fromScale(0, 0.55),
		TextColor3 = Theme.Muted, TextXAlignment = Enum.TextXAlignment.Center, MaxText = 14, Parent = gui })
	return gui, label, sub
end

local function create(id: string, kind: string, name: string): Ghost
	local model = Instance.new("Model")
	model.Name = id
	local g: any = { id = id, kind = kind, buf = Interp.new(), model = model, fade = 0, gone = false, base = {} }
	if kind == "vr" then
		g.head = ball(model, "Head", 1.6, 0.15)
		local visor = Instance.new("Part")
		visor.Name = "Visor"
		visor.Size = Vector3.new(1.3, 0.45, 0.3)
		visor.Color = Theme.Bg
		visor.Material = Enum.Material.SmoothPlastic
		visor.Anchored, visor.CanCollide, visor.CanQuery, visor.CanTouch = true, false, false, false
		visor.Parent = model
		g.visor = visor
		g.hl = ball(model, "HandL", 0.8, 0.1)
		g.hr = ball(model, "HandR", 0.8, 0.1)
		for _, hand in { g.hl, g.hr } do
			local a0 = Instance.new("Attachment")
			a0.Position = Vector3.new(0, 0.3, 0)
			a0.Parent = hand
			local a1 = Instance.new("Attachment")
			a1.Position = Vector3.new(0, -0.3, 0)
			a1.Parent = hand
			Theme.make("Trail", { Attachment0 = a0, Attachment1 = a1, Color = ColorSequence.new(Theme.Accent),
				Lifetime = 0.25, LightEmission = 1,
				Transparency = NumberSequence.new(0.3, 1), Parent = hand })
		end
		local body = Instance.new("Part")
		body.Name = "Body"
		body.Shape = Enum.PartType.Cylinder
		body.Material = Enum.Material.Neon
		body.Color = Theme.Accent
		body.Transparency = 0.75
		body.Anchored, body.CanCollide, body.CanQuery, body.CanTouch, body.CastShadow = true, false, false, false, false
		body.Parent = model
		g.body = body
		Theme.make("PointLight", { Color = Theme.Accent, Range = 14, Brightness = 1.5, Parent = g.head })
		Theme.make("Highlight", { FillTransparency = 1, OutlineColor = Theme.Accent,
			DepthMode = Enum.HighlightDepthMode.AlwaysOnTop, Parent = model })
		local _, label, sub = billboard(g.head, string.upper(name) .. " · VR", 2.2)
		g.label, g.sub = label, sub
		g.itChip = Theme.label({ Text = "IT", Size = UDim2.fromOffset(40, 22), Position = UDim2.new(0.5, -20, 0, -24),
			BackgroundTransparency = 0, BackgroundColor3 = Theme.Accent, TextColor3 = Theme.Bg,
			TextXAlignment = Enum.TextXAlignment.Center, FontFace = Theme.Heading, Visible = false,
			Parent = label.Parent })
		Theme.corner(8).Parent = g.itChip
	elseif kind == "web" then
		g.head = ball(model, "Orb", 1, 0.2)
		local _, label, sub = billboard(g.head, name, 1.4)
		g.label, g.sub = label, sub
	else
		local capsule = Instance.new("Part")
		capsule.Name = "Capsule"
		capsule.Shape = Enum.PartType.Cylinder
		capsule.Size = Vector3.new(5, 2, 2)
		capsule.Material = Enum.Material.SmoothPlastic
		capsule.Color = Theme.Text
		capsule.Transparency = 0.55
		capsule.Anchored, capsule.CanCollide, capsule.CanQuery, capsule.CanTouch = true, false, false, false
		capsule.Parent = model
		g.head = capsule
		local _, label, sub = billboard(capsule, name, 3.3)
		g.label, g.sub = label, sub
	end
	for _, d in model:GetDescendants() do
		if d:IsA("BasePart") then
			g.base[d] = d.Transparency
		end
	end
	model.Parent = folder
	ghosts[id] = g
	return g
end

function Ghosts.push(msg: any)
	if type(msg) ~= "table" or type(msg.id) ~= "string" then
		return
	end
	local g = ghosts[msg.id]
	if g and g.gone then
		g.model:Destroy()
		ghosts[msg.id] = nil
		g = nil
	end
	if not g then
		g = create(msg.id, msg.kind or "web", msg.name or msg.id)
	end
	Interp.push(g.buf, { stamp = msg.stamp, pos = msg.pos, yaw = msg.yaw or 0, head = msg.head, hl = msg.hl, hr = msg.hr })
end

function Ghosts.remove(id: string)
	local g = ghosts[id]
	if g then
		g.gone = true
	end
end

function Ghosts.clear()
	for id, g in ghosts do
		g.model:Destroy()
		ghosts[id] = nil
	end
end

-- The judge's head part (for the spectator camera), if drawn.
function Ghosts.judgeHead(): BasePart?
	for _, g in ghosts do
		if g.kind == "vr" and not g.gone then
			return g.head
		end
	end
	return nil
end

function Ghosts.update(dt: number)
	local now = workspace:GetServerTimeNow()
	local renderT = now - Interp.DELAY
	local offline = workspace:GetAttribute("Offline") == true
	local playing = workspace:GetAttribute("RoundState") == "playing"
	for id, g in ghosts do
		local s = Interp.sample(g.buf, renderT, now)
		local stale = (s == nil) or s.age > Interp.STALE
		local target = if g.gone then 0 elseif stale or offline then 0.3 else 1
		g.fade += (target - g.fade) * math.min(1, dt / 0.15)
		if g.gone and g.fade < 0.02 then
			g.model:Destroy()
			ghosts[id] = nil
			continue
		end
		if s and s.age > 8 and not g.gone then
			g.gone = true
		end
		if not s then
			continue
		end
		local yawCf = CFrame.Angles(0, s.yaw, 0)
		if g.kind == "vr" then
			local head = s.head or (s.pos + Vector3.new(0, 5.7, 0))
			g.head.CFrame = CFrame.new(head) * yawCf
			local visor = (g :: any).visor :: BasePart
			visor.CFrame = CFrame.new(head) * yawCf * CFrame.new(0, 0.1, -0.7)
			if g.hl and g.hr then
				g.hl.CFrame = CFrame.new(s.hl or (head + yawCf:VectorToWorldSpace(Vector3.new(-1.2, -1.6, -0.8))))
				g.hr.CFrame = CFrame.new(s.hr or (head + yawCf:VectorToWorldSpace(Vector3.new(1.2, -1.6, -0.8))))
			end
			if g.body then
				local h = math.max(head.Y - s.pos.Y - 0.6, 1)
				g.body.Size = Vector3.new(h, 1.4, 1.4)
				g.body.CFrame = CFrame.new(s.pos.X, s.pos.Y + h / 2, s.pos.Z) * CFrame.Angles(0, 0, math.pi / 2)
			end
			if g.itChip then
				g.itChip.Visible = playing
			end
		elseif g.kind == "web" then
			g.head.CFrame = CFrame.new((s.head or s.pos) + Vector3.new(0, 0, 0))
		else
			g.head.CFrame = CFrame.new(s.pos + Vector3.new(0, 2.5, 0)) * yawCf * CFrame.Angles(0, 0, math.pi / 2)
		end
		g.sub.Text = if stale or offline then "signal lost" else ""
		for part, base in g.base do
			part.LocalTransparencyModifier = 0
			part.Transparency = 1 - (1 - base) * g.fade
		end
	end
end

return Ghosts
