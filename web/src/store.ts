import { configureStore } from '@reduxjs/toolkit';
import { api } from './api';

export function makeStore() {
  return configureStore({
    reducer: { [api.reducerPath]: api.reducer },
    middleware: (defaults) => defaults().concat(api.middleware),
  });
}
