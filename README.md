# SyncTube

SyncTube is a full-stack web app where friends watch the same YouTube video together in real-time.

## Features

- Create watch rooms with random room IDs
- Share invite links so friends can join instantly
- Embedded YouTube player with synchronized playback
- Host-only playback controls (play/pause/seek/load video)
- Live chat for all room members
- Real-time user list with host indicator
- Join/leave system notifications
- Late joiners automatically sync to the current playback time

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript, YouTube IFrame Player API
- Backend: Node.js, Express.js, Socket.IO

## Project Structure

```text
.
├── server.js
├── package.json
├── README.md
└── public/
    ├── index.html
    ├── room.html
    ├── style.css
    └── client.js
```

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start the server:

```bash
npm start
```

3. Open in browser:

```text
http://localhost:3000
```

## How to Use

1. Enter a username and a YouTube URL/ID, then click **Create Room**.
2. Copy the invite link and send it to friends.
3. Friends join using the link (or room ID + username) and must enter a nickname.
4. The host controls playback; all viewers stay synchronized.
5. Use live chat to communicate in the room.

## Notes

- Rooms are stored in memory, so they reset when the server restarts.
- This is intended for single-server usage without persistence.

## Deploy From GitHub

This project cannot run on GitHub Pages because it needs a live Node.js server and Socket.IO connection.

Use GitHub as the source repo and deploy it on Render instead:

1. Push your code to GitHub.
2. Open Render and choose **New Web Service**.
3. Connect your GitHub account.
4. Select the repository: `variyaparth/SyncTube`.
5. Render will detect the included `render.yaml` file automatically.
6. Deploy the service.

After deployment, Render will give you a public live URL for SyncTube.

## Deploy On Koyeb

This project is now prepared for Koyeb using the included Dockerfile.

1. Push the latest code to GitHub.
2. Sign in to Koyeb and create a new Web Service from GitHub.
3. Select the repository: `variyaparth/SyncTube`.
4. Choose Docker-based deployment.
5. Set the exposed port to `3000` if Koyeb asks for it.
6. Set the health check path to `/health`.
7. Deploy the service.

Koyeb will build the image using [Dockerfile](Dockerfile) and expose the app publicly after the health check passes.
