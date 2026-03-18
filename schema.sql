-- CloudShare Database Schema
-- Run this SQL in your PostgreSQL database before starting the server

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Files Table
CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    original_name VARCHAR(500) NOT NULL,
    file_path TEXT NOT NULL,
    file_size BIGINT DEFAULT 0,
    mime_type VARCHAR(255),
    expiry TIMESTAMP NOT NULL,
    password TEXT DEFAULT NULL,
    download_limit INT DEFAULT 100,
    download_count INT DEFAULT 0,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id);
CREATE INDEX IF NOT EXISTS idx_files_expiry ON files(expiry);
