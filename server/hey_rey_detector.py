"""
Custom "Hey Rey" wake word detector using the trained PyTorch model.
"""

import numpy as np
import librosa
import torch
import torch.nn as nn
from pathlib import Path
from collections import deque
import logging

logger = logging.getLogger(__name__)

# Audio settings (must match training)
SAMPLE_RATE = 16000
N_MFCC = 40
HOP_LENGTH = 160
WIN_LENGTH = 400
N_FFT = 512
FRAME_LENGTH = 151  # Number of MFCC frames expected by model


class WakeWordModel(nn.Module):
    """Wake word detection model (same architecture as training)."""
    
    def __init__(self, input_dim=40, hidden_dim=64, num_layers=2):
        super().__init__()
        
        self.lstm = nn.LSTM(
            input_size=input_dim,
            hidden_size=hidden_dim,
            num_layers=num_layers,
            batch_first=True,
            bidirectional=True
        )
        
        self.fc = nn.Sequential(
            nn.Linear(hidden_dim * 2, hidden_dim),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(hidden_dim, 1),
            nn.Sigmoid()
        )
    
    def forward(self, x):
        lstm_out, _ = self.lstm(x)
        out = lstm_out[:, -1, :]
        return self.fc(out)


class HeyReyDetector:
    """
    Streaming wake word detector for "Hey Rey".
    
    Maintains a rolling buffer of audio and checks for the wake word
    whenever new audio arrives.
    """
    
    def __init__(self, model_path: str = None, threshold: float = 0.7):
        """
        Initialize the detector.
        
        Args:
            model_path: Path to the trained .pt model file
            threshold: Detection threshold (0-1)
        """
        self.threshold = threshold
        
        # Default model path
        if model_path is None:
            model_path = Path.home() / "gdrive" / "Rey-Wake-Word-Training" / "model" / "hey_rey_best.pt"
        
        self.model_path = Path(model_path)
        
        # Load model
        self.model = WakeWordModel(input_dim=N_MFCC)
        
        if self.model_path.exists():
            self.model.load_state_dict(torch.load(self.model_path, map_location='cpu'))
            self.model.eval()
            logger.info(f"Loaded Hey Rey model from {self.model_path}")
        else:
            logger.warning(f"Model not found at {self.model_path}, detector will not work")
            self.model = None
        
        # Rolling audio buffer (1.5 seconds at 16kHz)
        self.buffer_size = int(SAMPLE_RATE * 1.5)
        self.audio_buffer = deque(maxlen=self.buffer_size)
        
        # Prediction smoothing
        self.prediction_history = deque(maxlen=5)
        
        # Cooldown to prevent rapid re-triggering
        self.cooldown_samples = 0
        self.cooldown_duration = SAMPLE_RATE * 2  # 2 seconds
    
    def reset(self):
        """Reset the detector state."""
        self.audio_buffer.clear()
        self.prediction_history.clear()
        self.cooldown_samples = self.cooldown_duration  # Start cooldown
    
    def predict(self, audio_chunk: np.ndarray) -> dict:
        """
        Process an audio chunk and check for wake word.
        
        Args:
            audio_chunk: Audio samples as numpy array (float32 or int16)
        
        Returns:
            dict with 'hey_rey' key containing detection probability
        """
        if self.model is None:
            return {'hey_rey': 0.0}
        
        # Convert to float32 if needed
        if audio_chunk.dtype == np.int16:
            audio_chunk = audio_chunk.astype(np.float32) / 32768.0
        
        # Update cooldown
        if self.cooldown_samples > 0:
            self.cooldown_samples -= len(audio_chunk)
            return {'hey_rey': 0.0}
        
        # Add to buffer
        self.audio_buffer.extend(audio_chunk.tolist())
        
        # Need full buffer before prediction
        if len(self.audio_buffer) < self.buffer_size:
            return {'hey_rey': 0.0}
        
        # Extract audio
        audio = np.array(self.audio_buffer, dtype=np.float32)
        
        # Compute MFCCs
        try:
            mfcc = librosa.feature.mfcc(
                y=audio,
                sr=SAMPLE_RATE,
                n_mfcc=N_MFCC,
                hop_length=HOP_LENGTH,
                win_length=WIN_LENGTH,
                n_fft=N_FFT
            )
            
            # Transpose and ensure correct length
            features = mfcc.T
            if len(features) < FRAME_LENGTH:
                # Pad
                features = np.pad(features, ((0, FRAME_LENGTH - len(features)), (0, 0)))
            else:
                # Trim
                features = features[:FRAME_LENGTH]
            
            # Run inference
            with torch.no_grad():
                x = torch.FloatTensor(features).unsqueeze(0)
                prediction = self.model(x).item()
            
            # Smooth predictions
            self.prediction_history.append(prediction)
            smoothed = np.mean(self.prediction_history)
            
            return {'hey_rey': smoothed}
            
        except Exception as e:
            logger.error(f"Prediction error: {e}")
            return {'hey_rey': 0.0}


# For testing
if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    
    detector = HeyReyDetector()
    
    # Test with a recording
    test_dir = Path.home() / "gdrive" / "Rey-Wake-Word-Training" / "recordings"
    test_files = list(test_dir.glob("*.wav"))[:5]
    
    for test_file in test_files:
        audio, sr = librosa.load(test_file, sr=SAMPLE_RATE)
        
        # Reset detector
        detector.reset()
        detector.cooldown_samples = 0  # Disable cooldown for testing
        
        # Feed audio in chunks
        chunk_size = 512
        max_score = 0
        
        for i in range(0, len(audio), chunk_size):
            chunk = audio[i:i+chunk_size]
            result = detector.predict(chunk)
            max_score = max(max_score, result['hey_rey'])
        
        print(f"{test_file.name}: max score = {max_score:.3f}")
