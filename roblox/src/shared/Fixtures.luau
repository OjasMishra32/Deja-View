-- Fixture JSON from team/shivin.md 9.1. [=[ ]=] because the JSON contains "]]".
return {
	SCENES = [=[[
 {"id":"fixture-room","name":"Fixture room","mode":"photo","status":"ready","stage":"Ready","progress":1,"createdAt":"2026-10-17T10:00:00Z"},
 {"id":"mock-game-night","name":"Mock game night","mode":"video","status":"ready","stage":"Ready","progress":1,"createdAt":"2026-10-17T10:05:00Z"},
 {"id":"mock-finale","name":"Judge's photo","mode":"photo","status":"running","stage":"Generating the room","progress":0.4,"createdAt":"2026-10-17T10:06:00Z"},
 {"id":"mock-broken","name":"Broken","mode":"photo","status":"failed","stage":"Failed","progress":0,"error":"That one didn't work","createdAt":"2026-10-17T10:07:00Z"}]]=],

	MAP_SMALL = [=[{"sceneId":"fixture-room","name":"Fixture room","studsPerMeter":3.57,
 "spawn":[0,0,5],"ceilingY":10.4,"parts":[
 [0,-0.5,0,24,1,20,128,112,96],
 [0,5.2,-10.5,24,10.4,1,214,208,196],
 [0,5.2,10.5,24,10.4,1,214,208,196],
 [-12.5,5.2,0,1,10.4,20,205,199,188],
 [12.5,2,0,1,4,20,205,199,188],
 [12.5,9.2,0,1,2.4,20,205,199,188],
 [12.5,6,0,0.2,4,20,170,210,255],
 [-7,1,-5,8,2,10,70,90,140],
 [-7,2.4,-8.8,6,0.8,2,235,235,235],
 [6,3,4,6,0.4,4,150,110,70],
 [6,1.4,4,0.6,2.8,0.6,90,70,50],
 [9,4,-8,1,8,1,240,220,120]]}]=],

	PRESENCE = [=[{"t":1760715600.31,"others":[
 {"id":"quest-1","name":"Judge","kind":"vr","x":1.5,"y":0,"z":-3.93,"yaw":0.3,
  "hands":[[0.71,4.32,-5.0],[2.32,4.46,-4.82]]},
 {"id":"web-7f3a19c2","name":"Maya","kind":"web","x":-3.57,"y":0,"z":2.86,"yaw":3.1}]}]=],
}
