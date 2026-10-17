-- Client: UI controller + ghost renderer. Reads workspace/player attributes, listens to Moment and GhostState.
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local StarterGui = game:GetService("StarterGui")
local UserInputService = game:GetService("UserInputService")

local Modules = script.Parent:WaitForChild("Modules")
local Ui = require(Modules.Ui)
local Board = require(Modules.Board)
local Ghosts = require(Modules.Ghosts)
local Effects = require(Modules.Effects)
local Theme = require(ReplicatedStorage:WaitForChild("Shared").Theme)

local Remotes = ReplicatedStorage:WaitForChild("Remotes")
local GhostState = Remotes:WaitForChild("GhostState") :: UnreliableRemoteEvent
local Moment = Remotes:WaitForChild("Moment") :: RemoteEvent
local Vote = Remotes:WaitForChild("Vote") :: RemoteEvent
local HostAction = Remotes:WaitForChild("HostAction") :: RemoteEvent

local player = Players.LocalPlayer
local ui = Ui.build()
local make, label = Theme.make, Theme.label

task.spawn(function()
	for _ = 1, 10 do
		if pcall(StarterGui.SetCoreGuiEnabled, StarterGui, Enum.CoreGuiType.PlayerList, false) then
			break
		end
		task.wait(1)
	end
end)

local function W(name: string): any
	return workspace:GetAttribute(name)
end

local function where(): string
	return player:GetAttribute("Where") or "lobby"
end

local function isHost(): boolean
	return player:GetAttribute("IsHost") == true
end

-- Lobby board (SurfaceGui in PlayerGui so the cards are clickable)
local boardList: Instance? = nil
local boardStatus: TextLabel? = nil
task.spawn(function()
	local lobby = workspace:WaitForChild("Lobby", 30)
	local part = lobby and lobby:WaitForChild("Board", 30)
	if not part then
		return
	end
	local sg = make("SurfaceGui", { Name = "LobbyBoard", Adornee = part, Face = Enum.NormalId.Front,
		SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud, PixelsPerStud = 40, LightInfluence = 0,
		ResetOnSpawn = false, Parent = player:WaitForChild("PlayerGui") })
	local root = make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = Theme.Bg, Parent = sg },
		{ make("UIPadding", { PaddingLeft = UDim.new(0, 40), PaddingRight = UDim.new(0, 40), PaddingTop = UDim.new(0, 30),
			PaddingBottom = UDim.new(0, 30) }) })
	label({ Text = "DÉJÀ VIEW", TextColor3 = Theme.Accent, FontFace = Theme.Heading, Size = UDim2.new(0.5, 0, 0, 60),
		MaxText = 60, Parent = root })
	boardStatus = label({ Text = "", FontFace = Theme.Heading, Size = UDim2.new(1, 0, 0, 70), Position = UDim2.new(0, 0, 0, 64),
		MaxText = 64, Parent = root })
	local list = make("Frame", { BackgroundTransparency = 1, Position = UDim2.new(0, 0, 0, 160), Size = UDim2.new(1, 0, 1, -160),
		Parent = root }, { make("UIGridLayout", { CellSize = UDim2.new(0.235, 0, 0.3, 0), CellPadding = UDim2.new(0.02, 0, 0.04, 0),
		SortOrder = Enum.SortOrder.LayoutOrder }) })
	boardList = list
end)

local cards: { any } = {}
local function renderCards()
	local ok, decoded = pcall(HttpService.JSONDecode, HttpService, W("RoomsJson") or "[]")
	cards = if ok and type(decoded) == "table" then decoded else {}
	local current = W("SceneId")
	local function pick(id: string)
		Vote:FireServer(id)
		ui.panel.Visible = false
	end
	if boardList then
		Board.render(boardList, cards, current, pick)
	end
	if ui.panel.Visible then
		Board.render(ui.panelList, cards, current, pick)
	end
end

local function anyoneInLobby(): boolean
	for _, p in Players:GetPlayers() do
		if (p:GetAttribute("Where") or "lobby") ~= "room" then
			return true
		end
	end
	return false
end

local bootDone = false
local function refresh()
	local phase = W("Phase") or "lobby"
	local roomName = W("RoomName") or ""
	local inRoom = where() == "room"
	local judge = W("JudgeHere") == true
	local round = W("RoundState") or "idle"

	-- loading screen
	local showLoading = (not bootDone) or (phase == "loading" and inRoom)
	if showLoading then
		ui.loading.Visible = true
		ui.loadRoom.Text = string.upper(roomName)
		ui.loadTitle.Text = if (W("LoadStage") or "") == "Measuring the room..." then "Measuring the room..." else "Moving in..."
		local p = W("LoadProgress") or 0
		ui.loadFill.Size = UDim2.fromScale(math.clamp(p, 0, 1), 1)
		local built, total = W("LoadBuilt") or 0, W("LoadTotal") or 0
		ui.loadCount.Text = if total > 0 then string.format("%s / %s blocks", tostring(built), tostring(total)) else ""
	elseif ui.loading.Visible and not ui.loadingFading then
		ui.loadingFading = true
		Ui.fadeOut(ui.loading, 0.6)
		task.delay(0.65, function()
			ui.loadingFading = false
		end)
	end

	-- status lines
	local status
	if inRoom then
		ui.roomName.Text = string.upper(roomName)
		status = if round == "playing" then "TAG: THE JUDGE IS IT"
			elseif judge then (W("JudgeName") or "Judge") .. " is here"
			else ""
	else
		ui.roomName.Text = "LOBBY"
		if phase == "loading" then
			status = "Building " .. roomName .. "..."
		elseif judge and roomName ~= "" then
			status = "JUDGE IS IN " .. string.upper(roomName)
		elseif phase == "room" then
			status = "Room ready · JOIN"
		else
			status = "Waiting for a room..."
		end
	end
	ui.status.Text = status
	if boardStatus then
		boardStatus.Text = if inRoom then "" else status
		boardStatus.TextColor3 = if judge then Theme.Accent else Theme.Text
	end

	-- buttons
	local host = isHost()
	ui.host.Visible = host
	ui.joinBtn.Visible = host and phase == "room" and anyoneInLobby()
	ui.hopBtn.Visible = (phase == "room" and not inRoom and not host) or inRoom
	ui.hopBtn.Text = if inRoom then "LOBBY" else "HOP IN"
	ui.autoBtn.Text = "AUTO-JOIN: " .. (if W("AutoJoin") then "ON" else "OFF")
	ui.followBtn.Text = "FOLLOW: " .. (if W("Follow") then "ON" else "OFF")
	ui.mockBtn.Text = "MOCK JUDGE: " .. (if W("MockJudge") then "ON" else "OFF")
	ui.realityBtn.Visible = W("HasImagined") == true and inRoom

	-- banner
	local banner = W("Banner") or ""
	ui.banner.Visible = banner ~= ""
	ui.banner.Text = banner

	ui.score.Visible = round == "playing" or round == "countdown" or round == "ended"
end

local function renderScores()
	for _, c in ui.scoreRows:GetChildren() do
		if c:IsA("Frame") then
			c:Destroy()
		end
	end
	local ok, s = pcall(HttpService.JSONDecode, HttpService, W("ScoresJson") or "")
	if not ok or type(s) ~= "table" then
		return
	end
	Ui.scoreRow(ui.scoreRows, string.upper(s.vrName or "JUDGE") .. " · IT", tostring(s.vrTags or 0) .. " TAGS", Theme.Accent, 0)
	for i, r in s.runners or {} do
		local dots = string.rep("●", math.max(r.lives, 0)) .. string.rep("○", math.max(3 - r.lives, 0))
		Ui.scoreRow(ui.scoreRows, r.name, if r.out then "OUT" else dots, if r.out then Theme.Muted else Theme.Text, i)
	end
end

-- Remote moments
Moment.OnClientEvent:Connect(function(m)
	if type(m) ~= "table" then
		return
	end
	if m.type == "toast" then
		Ui.toast(ui, m.text)
	elseif m.type == "gone" then
		Ghosts.remove(m.id)
	elseif m.type == "tagged" then
		Effects.burst(m.pos)
		Effects.sound("tag")
		if m.userId == player.UserId then
			Effects.shake(0.5, 6)
			Ui.big(ui, "TAGGED", if m.lives > 0 then m.lives .. " lives left" else "You're out", Theme.Danger, 1.4)
		else
			Ui.toast(ui, string.upper(m.name) .. " GOT TAGGED")
		end
	elseif m.type == "countdown" then
		task.spawn(function()
			for i = m.seconds or 3, 1, -1 do
				Ui.big(ui, tostring(i), m.text, Theme.Accent, 0.95)
				Effects.sound("tick")
				task.wait(1)
			end
		end)
	elseif m.type == "roundStart" then
		Ui.big(ui, "GO!", "The judge is it · " .. tostring(m.duration) .. " s", Theme.Accent, 1.2)
	elseif m.type == "winner" then
		ui.winTitle.Text = m.title
		ui.winSub.Text = m.mvp or ""
		ui.winner.Visible = true
		Effects.sound("win")
		task.delay(5, function()
			ui.winner.Visible = false
		end)
	end
end)

GhostState.OnClientEvent:Connect(Ghosts.push)

-- Buttons
local function host(action: string, value: any?)
	HostAction:FireServer(action, value)
end
ui.roomsBtn.Activated:Connect(function()
	ui.panel.Visible = not ui.panel.Visible
	renderCards()
end)
ui.closeBtn.Activated:Connect(function()
	ui.panel.Visible = false
end)
ui.hopBtn.Activated:Connect(function()
	host(if where() == "room" then "to_lobby" else "hop_in")
end)
ui.joinBtn.Activated:Connect(function()
	host("join")
end)
ui.autoBtn.Activated:Connect(function()
	host("auto_join", not W("AutoJoin"))
end)
ui.followBtn.Activated:Connect(function()
	host("follow", not W("Follow"))
end)
ui.mockBtn.Activated:Connect(function()
	host("mock_judge", not W("MockJudge"))
end)
ui.startBtn.Activated:Connect(function()
	host("start_round")
end)
ui.endBtn.Activated:Connect(function()
	host("end_round")
end)
ui.lobbyAllBtn.Activated:Connect(function()
	host("lobby_all")
end)
local reality = false
ui.realityBtn.Activated:Connect(function()
	reality = not reality
	Effects.setReality(reality)
	ui.realityBtn.BackgroundColor3 = if reality then Theme.Imagined else Theme.Surface
end)

UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.R then
		ui.panel.Visible = not ui.panel.Visible
		renderCards()
	end
end)

-- Attribute wiring
for _, name in { "Phase", "RoomName", "LoadProgress", "LoadStage", "Banner", "JudgeHere", "JudgeName", "RoundState",
	"AutoJoin", "Follow", "MockJudge", "HasImagined" } do
	workspace:GetAttributeChangedSignal(name):Connect(refresh)
end
workspace:GetAttributeChangedSignal("RoomsJson"):Connect(renderCards)
workspace:GetAttributeChangedSignal("ScoresJson"):Connect(renderScores)
workspace:GetAttributeChangedSignal("SceneId"):Connect(function()
	Ghosts.clear()
	reality = false
	Effects.setReality(false)
	ui.realityBtn.BackgroundColor3 = Theme.Surface
	renderCards()
end)
player:GetAttributeChangedSignal("Where"):Connect(refresh)
player:GetAttributeChangedSignal("IsHost"):Connect(refresh)
local function watchPlayer(p: Player)
	p:GetAttributeChangedSignal("Where"):Connect(refresh)
end
Players.PlayerAdded:Connect(watchPlayer)
Players.PlayerRemoving:Connect(function()
	task.defer(refresh)
end)
for _, p in Players:GetPlayers() do
	watchPlayer(p)
end

-- Per frame: ghosts, timer, spectator camera
local lastSubjectCheck = 0
RunService.RenderStepped:Connect(function(dt)
	Ghosts.update(dt)
	local round = W("RoundState")
	if round == "playing" then
		local left = math.max(0, (W("RoundEndsAt") or 0) - workspace:GetServerTimeNow())
		ui.timer.Text = string.format("%d:%02d", left // 60, math.floor(left % 60))
		ui.timer.TextColor3 = if left < 10 then Theme.Danger else Theme.Text
	elseif round == "countdown" then
		ui.timer.Text = "READY"
	elseif round == "ended" then
		ui.timer.Text = "DONE"
	end
	if os.clock() - lastSubjectCheck > 0.5 then
		lastSubjectCheck = os.clock()
		local cam = workspace.CurrentCamera
		local hum = player.Character and player.Character:FindFirstChildOfClass("Humanoid")
		local head = Ghosts.judgeHead()
		if player:GetAttribute("Out") and head then
			cam.CameraSubject = head
		elseif hum and cam.CameraSubject ~= hum then
			cam.CameraSubject = hum
		end
	end
end)

-- Small screens: compact scoreboard
local function layoutForScreen()
	local w = workspace.CurrentCamera.ViewportSize.X
	ui.scoreRows.Visible = w >= 700
	ui.panelList:FindFirstChildOfClass("UIGridLayout").CellSize = if w < 700 then UDim2.new(0.48, 0, 0, 140) else UDim2.new(0.31, 0, 0, 150)
end
workspace.CurrentCamera:GetPropertyChangedSignal("ViewportSize"):Connect(layoutForScreen)
layoutForScreen()

-- Ages and NEW chips expire: re-render now and then
task.spawn(function()
	while true do
		task.wait(10)
		renderCards()
	end
end)

-- Boot: the dark loading screen fades into the lobby
task.delay(1.2, function()
	bootDone = true
	refresh()
end)
refresh()
renderCards()
renderScores()
