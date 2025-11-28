#!/usr/bin/env bash
set -e

echo "🔮 Setting up Thaumic Cast..."

# Check for bun
if ! command -v bun &> /dev/null; then
  echo "❌ Bun is required but not installed."
  echo "   Install it from: https://bun.sh"
  exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
bun install

# Create .env if it doesn't exist
if [ ! -f .env ]; then
  echo "🔐 Creating .env file..."
  cp .env.example .env

  # Generate secrets
  AUTH_SECRET=$(openssl rand -base64 32)
  STREAM_JWT_SECRET=$(openssl rand -base64 32)

  # Replace placeholder secrets (works on both macOS and Linux)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|AUTH_SECRET=.*|AUTH_SECRET=$AUTH_SECRET|" .env
    sed -i '' "s|STREAM_JWT_SECRET=.*|STREAM_JWT_SECRET=$STREAM_JWT_SECRET|" .env
  else
    sed -i "s|AUTH_SECRET=.*|AUTH_SECRET=$AUTH_SECRET|" .env
    sed -i "s|STREAM_JWT_SECRET=.*|STREAM_JWT_SECRET=$STREAM_JWT_SECRET|" .env
  fi

  echo "   ✅ Generated random secrets"
  echo "   ⚠️  Don't forget to add your Sonos API credentials to .env"
else
  echo "   ℹ️  .env already exists, skipping"
fi

# Symlink .env to server directory
if [ ! -L server/.env ]; then
  ln -sf ../.env server/.env
  echo "   ✅ Symlinked .env to server/"
fi

# Create data directory
mkdir -p server/data
echo "   ✅ Created server/data directory"

# Run database migrations
echo "🗄️  Running database migrations..."
cd server
bunx --bun @better-auth/cli migrate --config ./src/auth.ts --yes
cd ..

# Build the UI
echo "🎨 Building server UI..."
bun run --filter @thaumic-cast/server-ui build

echo ""
echo "✅ Setup complete!"
echo ""
echo "To start the server:"
echo "  cd server && bun run dev"
echo ""
echo "To build the extension:"
echo "  cd extension && bun run build"
