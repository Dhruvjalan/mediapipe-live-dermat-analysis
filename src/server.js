const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const authRoutes = require('./routes/auth');

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// MongoDB Connection
const MONGO_URI = process.env.VITE_MONGODB_URI || 'mongodb://127.0.0.1:27017/ayurgenx';
mongoose.connect(MONGO_URI)
  .then(() => console.log('Connected to MongoDB successfully: ayurgenx'))
  .catch(err => console.error('MongoDB connection error:', err));

// API Routes
app.use('/api/auth', authRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`AyurGenX backend server running on port ${PORT}`);
});