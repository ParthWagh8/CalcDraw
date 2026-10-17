
![CalcDraw banner](<Banner.png>)

**Live:** https://calcdraw.leon-xenox8.workers.dev  

### Your canvas for curiosity! 🎨 Ask questions, sketch your ideas, and get answers to academic questions across Math, Science, Social Studies, and more. All in one place.
## Features
1. Infinite Canvas<br>
2. Eraser, Pen, Move tool, Undo, Redo<br>
3. Shapes: Rectangle, Square, Ellipse, Triangle, Right-Triangle, Diamond, Line, Arrow<br>
4. Uniform 3px stroke, 12 color palette<br>
5. AI analyze geometric figures, solve equations and give answer<br>
6. It can also solve text based questions<br>
7. Light and Dark mode available<br>

## Tech Stack

| Layer | Stack |
| --- | --- |
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS v4, react-draggable, lucide-react, MathJax (cdnjs), axios |
| Backend | Python 3.12, FastAPI, Pydantic, Pillow, requests, uvicorn |
| AI | OpenRouter vision model (`nvidia/nemotron-3.5-super-vl:free`) |

## Setup

Prerequisites: Node 18+, Python 3.12, an OpenRouter API key<br>

**Backend**

```bash
cd Backend
python -m venv .venv && .venv\Scripts\activate   
pip install -r requirements.txt
cp .env.example .env        # set OPENROUTER_API_KEY 
python main.py              # http://localhost:8900
```

**Frontend**

```bash
cd Frontend
npm install
cp .env.example .env        # VITE_API_URL=http://localhost:8900
npm run dev                 # http://localhost:5174
```
