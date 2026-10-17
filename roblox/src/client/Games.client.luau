-- Real ping pong input (team/seb.md Update 5): hold to charge, aim with the camera or the hand, release to hit.
-- Its own LocalScript, so Client.client.luau stays Shivin's.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local player = Players.LocalPlayer

-- Diagnostic HUD, drawn before anything else so a stall is visible on screen.
local diagGui = Instance.new("ScreenGui")
diagGui.Name = "PPDiag"
diagGui.ResetOnSpawn = false
diagGui.IgnoreGuiInset = true
diagGui.Parent = player:WaitForChild("PlayerGui")
local diag = Instance.new("TextLabel")
diag.Size = UDim2.fromOffset(620, 22)
diag.Position = UDim2.fromOffset(12, 120)
diag.BackgroundTransparency = 0.35
diag.BackgroundColor3 = Color3.fromRGB(0, 0, 0)
diag.Font = Enum.Font.Code
diag.TextSize = 14
diag.TextColor3 = Color3.fromRGB(120, 255, 150)
diag.TextXAlignment = Enum.TextXAlignment.Left
diag.Text = "PP CLIENT v5: start"
diag.Parent = diagGui
local function dbg(text: string)
	diag.Text = "PP CLIENT v5: " .. text
	print("[PingPong] " .. text)
end

local PingPongView = require(ReplicatedStorage:WaitForChild("Shared"):WaitForChild("PingPongView"))

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local function need(name: string, class: string): any
	dbg("waiting for " .. name)
	local r = Remotes:WaitForChild(name, 15)
	if not r then
		dbg("MISSING " .. name)
		error("missing remote " .. name)
	end
	dbg("got " .. name .. " (" .. r.ClassName .. ")")
	return r
end
local PPPaddle = need("PPPaddle", "UnreliableRemoteEvent") :: UnreliableRemoteEvent
local PPHit = need("PPHit", "RemoteEvent") :: RemoteEvent
local PPState = need("PPState", "RemoteEvent") :: RemoteEvent
local PPSide = need("PPSide", "RemoteEvent") :: RemoteEvent
local PPJoin = need("PPJoin", "RemoteEvent") :: RemoteEvent
local PPWho = need("PPWho", "RemoteFunction") :: RemoteFunction
dbg("remotes ready")

local GRIP = CFrame.new(0, 0, -0.35) * CFrame.Angles(math.rad(-20), 0, 0)
local PADDLE_SEND = 1 / 30
local ASSIST_SEND = 1 / 5
local CHARGE_MAX = 0.8 -- seconds from min to max; then back down and up again
local CHARGE_MIN = 0.06

local lastSend = 0
local lastAssist = 0
local hand = Enum.UserCFrame.RightHand
local active = false
local mySide: string? = nil
local canHit = false
local bounce: string? = nil
local serving = false
local serveSide: string? = nil
local lastBlade: CFrame? = nil
local paddleVel = Vector3.zero

print("[PingPong] client charge v3")
local tableC: Vector3? = nil
local tableYaw = 0
local tableLen = 9.78
local tableWid = 5.44

local charging = false
local chargeStart = 0
local charge = 0
local prevCameraMode: Enum.CameraMode? = nil

-- HUD
local gui = Instance.new("ScreenGui")
gui.Name = "PPHud"
gui.ResetOnSpawn = false
gui.Parent = player:WaitForChild("PlayerGui")

local hitButton = Instance.new("TextButton")
hitButton.Name = "PPHit"
hitButton.Size = UDim2.fromOffset(132, 132)
hitButton.AnchorPoint = Vector2.new(1, 1)
hitButton.Position = UDim2.new(1, -28, 1, -28)
hitButton.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
hitButton.BackgroundTransparency = 0.1
hitButton.Text = "HIT"
hitButton.TextScaled = false
hitButton.TextSize = 24
hitButton.Font = Enum.Font.GothamBold
hitButton.TextColor3 = Color3.fromRGB(0, 122, 255)
hitButton.Visible = false
hitButton.Parent = gui
local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(1, 0)
corner.Parent = hitButton

local barBack = Instance.new("Frame")
barBack.Name = "PPPower"
barBack.Size = UDim2.fromOffset(260, 16)
barBack.AnchorPoint = Vector2.new(0.5, 1)
barBack.Position = UDim2.new(0.5, 0, 1, -34)
barBack.BackgroundColor3 = Color3.fromRGB(20, 20, 20)
barBack.BackgroundTransparency = 0.35
barBack.Visible = false
barBack.Parent = gui
local barBackCorner = Instance.new("UICorner")
barBackCorner.CornerRadius = UDim.new(1, 0)
barBackCorner.Parent = barBack
local barFill = Instance.new("Frame")
barFill.Name = "Fill"
barFill.Size = UDim2.fromScale(0, 1)
barFill.BackgroundColor3 = Color3.fromRGB(0, 122, 255)
barFill.BorderSizePixel = 0
barFill.Parent = barBack
local barFillCorner = Instance.new("UICorner")
barFillCorner.CornerRadius = UDim.new(1, 0)
barFillCorner.Parent = barFill

local version = Instance.new("TextLabel")
version.Name = "PPVersion"
version.Size = UDim2.fromOffset(240, 22)
version.AnchorPoint = Vector2.new(0, 1)
version.Position = UDim2.new(0, 24, 1, -24)
version.BackgroundTransparency = 1
version.Font = Enum.Font.GothamBold
version.TextSize = 14
version.TextColor3 = Color3.fromRGB(255, 255, 255)
version.TextStrokeTransparency = 0.5
version.TextXAlignment = Enum.TextXAlignment.Left
version.Text = "PING PONG v3  ·  hold to charge"
version.Visible = false
version.Parent = gui

local reticle = Instance.new("Frame")
reticle.Name = "PPAim"
reticle.Size = UDim2.fromOffset(10, 10)
reticle.AnchorPoint = Vector2.new(0.5, 0.5)
reticle.Position = UDim2.fromScale(0.5, 0.5)
reticle.BackgroundColor3 = Color3.fromRGB(255, 255, 255)
reticle.BackgroundTransparency = 0.15
reticle.BorderSizePixel = 0
reticle.Visible = false
reticle.Parent = gui
local reticleCorner = Instance.new("UICorner")
reticleCorner.CornerRadius = UDim.new(1, 0)
reticleCorner.Parent = reticle

local function refreshHitButton()
	local mine = mySide
	if not active then
		hitButton.Visible = false
		canHit = false
		return
	end
	hitButton.Visible = true
	version.Text = if mine
		then "PING PONG v3  ·  side " .. mine .. "  ·  hold to charge"
		else "PING PONG v3  ·  press JOIN to play"
	if not mine then
		hitButton.Text = "JOIN"
		canHit = false
		hitButton.BackgroundTransparency = 0.1
		hitButton.TextColor3 = Color3.fromRGB(0, 122, 255)
		return
	end
	local serveNow = serving and serveSide == mine
	canHit = serveNow or bounce == mine
	if charging then
		hitButton.Text = "POWER"
	elseif canHit then
		hitButton.Text = if serveNow then "SERVE" else "HIT"
	else
		hitButton.Text = "WAIT"
	end
	hitButton.BackgroundTransparency = if canHit then 0.1 else 0.6
	hitButton.TextColor3 = if canHit then Color3.fromRGB(0, 122, 255) else Color3.fromRGB(150, 150, 155)
end

local function bladeCframe(): CFrame?
	local cam = workspace.CurrentCamera
	if not cam then
		return nil
	end
	local h = UserInputService:GetUserCFrame(hand)
	return cam.CFrame * CFrame.new(h.Position * cam.HeadScale) * h.Rotation
end

local function aimDir(): Vector3?
	if UserInputService.VREnabled and lastBlade then
		return lastBlade.LookVector
	end
	local cam = workspace.CurrentCamera
	return if cam then cam.CFrame.LookVector else nil
end

local function beginCharge()
	if not active or not mySide or charging then
		return
	end
	charging = true
	chargeStart = os.clock()
	charge = 0
	barBack.Visible = true
	reticle.Visible = not UserInputService.VREnabled
	if not UserInputService.VREnabled then
		prevCameraMode = player.CameraMode
		player.CameraMode = Enum.CameraMode.LockFirstPerson
		UserInputService.MouseBehavior = Enum.MouseBehavior.LockCenter
	end
	refreshHitButton()
end

-- Leave the charge: hide the bar and give the camera and the mouse back.
local function stopCharge()
	charging = false
	charge = 0
	barBack.Visible = false
	reticle.Visible = false
	if prevCameraMode then
		player.CameraMode = prevCameraMode
		prevCameraMode = nil
	end
	if not UserInputService.VREnabled then
		UserInputService.MouseBehavior = Enum.MouseBehavior.Default
	end
end

local function endCharge()
	if not charging then
		return
	end
	local phase = ((os.clock() - chargeStart) / CHARGE_MAX) % 2
	local held = math.clamp(if phase <= 1 then phase else 2 - phase, CHARGE_MIN, 1)
	stopCharge()
	local dir = aimDir()
	if not dir then
		refreshHitButton()
		return
	end
	if UserInputService.VREnabled then
		local b = workspace:FindFirstChild("PPBall", true)
		local cf = lastBlade
		if b and b:IsA("BasePart") and cf then
			PPHit:FireServer({
				vr = true,
				cf = cf,
				vel = paddleVel,
				p = b.Position,
				t = workspace:GetServerTimeNow(),
				charge = held,
				dir = dir,
			})
		end
	else
		PPHit:FireServer({ charge = held, dir = dir })
	end
	refreshHitButton()
end

hitButton.InputBegan:Connect(function(input)
	if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
		if active and not mySide then
			PPJoin:FireServer()
		else
			beginCharge()
		end
	end
end)
hitButton.InputEnded:Connect(function(input)
	if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
		endCharge()
	end
end)

UserInputService.InputBegan:Connect(function(input, processed)
	if processed or not active then
		return
	end
	local k = input.KeyCode
	if input.UserInputType == Enum.UserInputType.MouseButton1 and not charging then
		beginCharge()
	elseif input.UserInputType == Enum.UserInputType.Touch and not charging then
		beginCharge()
	elseif k == Enum.KeyCode.E or k == Enum.KeyCode.ButtonR2 or k == Enum.KeyCode.ButtonL2 then
		beginCharge()
	end
end)
UserInputService.InputEnded:Connect(function(input)
	local k = input.KeyCode
	if input.UserInputType == Enum.UserInputType.MouseButton1 or input.UserInputType == Enum.UserInputType.Touch then
		endCharge()
	elseif k == Enum.KeyCode.E or k == Enum.KeyCode.ButtonR2 or k == Enum.KeyCode.ButtonL2 then
		endCharge()
	end
end)

local function clampToScope()
	if not charging or UserInputService.VREnabled or not tableC or not mySide then
		return
	end
	local char = player.Character
	local hrp = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
	if not hrp then
		return
	end
	local tf = CFrame.new(tableC) * CFrame.Angles(0, tableYaw, 0)
	local lp = tf:PointToObjectSpace(hrp.Position)
	local x = math.clamp(lp.X, -(tableWid / 2 + 3), tableWid / 2 + 3)
	local zMin, zMax
	if mySide == "A" then
		zMin, zMax = -tableLen / 2 - 12, -tableLen / 2 + 1
	else
		zMin, zMax = tableLen / 2 - 1, tableLen / 2 + 12
	end
	local z = math.clamp(lp.Z, zMin, zMax)
	if (Vector3.new(x, lp.Y, z) - lp).Magnitude > 0.05 then
		local world = tf:PointToWorldSpace(Vector3.new(x, lp.Y, z))
		hrp.CFrame = CFrame.new(world) * (hrp.CFrame - hrp.CFrame.Position)
	end
end

RunService.RenderStepped:Connect(function(dt)
	if not active then
		return
	end
	PingPongView.update(dt)
	local t = os.clock()
	if UserInputService.VREnabled then
		local cf = bladeCframe()
		if cf then
			local bladeCf = cf * GRIP
			if lastBlade then
				paddleVel = (bladeCf.Position - lastBlade.Position) / math.max(0.008, dt)
			end
			lastBlade = bladeCf
			if t - lastSend >= PADDLE_SEND then
				lastSend = t
				PPPaddle:FireServer(bladeCf)
			end
		end
	elseif t - lastAssist >= ASSIST_SEND then
		lastAssist = t
		local char = player.Character
		local hrp = char and char:FindFirstChild("HumanoidRootPart") :: BasePart?
		if hrp then
			PPPaddle:FireServer(hrp.CFrame * CFrame.new(1.4, -0.2, -1.1) * GRIP)
		end
	end
	if charging then
		-- triangle wave: min -> max -> min -> max while the button stays held
		local phase = ((t - chargeStart) / CHARGE_MAX) % 2
		charge = if phase <= 1 then phase else 2 - phase
		barFill.Size = UDim2.fromScale(charge, 1)
		barFill.BackgroundColor3 = Color3.fromRGB(0, 122, 255):Lerp(Color3.fromRGB(255, 90, 60), charge)
		clampToScope()
	end
end)

PPPaddle.OnClientEvent:Connect(function(userId, cf)
	if type(userId) == "number" and typeof(cf) == "CFrame" then
		PingPongView.paddle(userId, cf)
	end
end)
Players.PlayerRemoving:Connect(function(p)
	PingPongView.remove(p.UserId)
end)

-- The table closed: no side, no charge, no paddles.
local function deactivate()
	mySide = nil
	if charging then
		stopCharge()
	end
	PingPongView.clear()
end

task.spawn(function()
	local ok, side = pcall(function()
		return PPWho:InvokeServer()
	end)
	if ok and (side == "A" or side == "B") then
		mySide = side
		print("[PingPong] my side:", side)
		refreshHitButton()
	end
end)

PPSide.OnClientEvent:Connect(function(side)
	if side == "A" or side == "B" then
		mySide = side
		refreshHitButton()
	end
end)

PPState.OnClientEvent:Connect(function(msg)
	if type(msg) ~= "table" then
		return
	end
	if type(msg.sides) == "table" then
		if msg.sides.A == player.UserId then
			mySide = "A"
		elseif msg.sides.B == player.UserId then
			mySide = "B"
		elseif mySide and msg.sides[mySide] ~= player.UserId then
			mySide = nil
		end
	end
	if msg.active ~= nil then
		active = msg.active == true
		dbg(if active then "active" else "inactive")
		version.Visible = active
		if not active then
			deactivate()
		end
		-- the board message always carries the last bounce; a missing one means none since the last hit
		bounce = msg.bounce
	end
	if msg.serve ~= nil then
		serveSide = msg.serve
	end
	if msg.serving ~= nil then
		serving = msg.serving == true
	end
	if typeof(msg.c) == "Vector3" then
		tableC = msg.c
	end
	if type(msg.yaw) == "number" then
		tableYaw = msg.yaw
	end
	if type(msg.len) == "number" then
		tableLen = msg.len
	end
	if type(msg.wid) == "number" then
		tableWid = msg.wid
	end
	refreshHitButton()
end)

workspace:GetAttributeChangedSignal("PPActive"):Connect(function()
	local on = workspace:GetAttribute("PPActive") == true
	if on ~= active then
		active = on
		if not on then
			deactivate()
		end
		refreshHitButton()
	end
end)
