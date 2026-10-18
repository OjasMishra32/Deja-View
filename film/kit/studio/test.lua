-- Smoke test: report that HTTP and loadstring work, and capture one frame of the window.
local H = game:GetService("HttpService")
H:GetAsync("http://127.0.0.1:8799/log?m=" .. H:UrlEncode("hello from studio, parts in Film: " .. tostring(workspace:FindFirstChild("Film") and #workspace.Film:GetDescendants() or 0)))
local S = 3.57
local c = workspace.CurrentCamera
c.FieldOfView = 55
c.CFrame = CFrame.lookAt(Vector3.new(0.3, 1.6, 1.6) * S, Vector3.new(0.6, 1.0, -4.7) * S)
task.wait(0.3)
H:GetAsync("http://127.0.0.1:8799/shot?take=test&i=0")
print("TEST DONE")
