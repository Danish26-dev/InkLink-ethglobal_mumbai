import express, { type Express } from 'express';
import cors from 'cors';
import agentRoutes from './routes/agentRoutes.js';
import operatorRoutes from './routes/operatorRoutes.js';
import { errorHandler } from './middleware/errorHandler.js';
import { parseOrigins } from './config.js';

const app: Express = express();

// CORS is OFF unless AGENT_ALLOWED_ORIGINS is set. The agent is called
// server-side by the Inklink backend; browsers should not call it directly.
// Read straight from the environment so importing the app (e.g. in tests)
// never requires the model-provider configuration.
const allowedOrigins = parseOrigins(process.env.AGENT_ALLOWED_ORIGINS);
if (allowedOrigins.length > 0) {
  app.use(cors({ origin: allowedOrigins }));
}

// Documents arrive as multipart uploads (multer); JSON bodies are small.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ limit: '1mb', extended: true }));

app.use('/api', agentRoutes);
app.use('/api/operator', operatorRoutes);

app.use(errorHandler);

export default app;
